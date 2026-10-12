import Anthropic from "@anthropic-ai/sdk";

// Turns technician-dictated text into clean job-record prose with Claude.
// Used by /api/ai/polish-note, which both "Polish with AI" and "Record note"
// call (dictation itself happens on the phone or in the browser — no audio is
// sent to the server), so a note reads the same whichever way it was entered.

export const POLISH_SYSTEM_PROMPT = `You clean up plumbing technician job notes that are often dictated via voice-to-text on a phone. Rewrite the note so it reads as clear, professional, concise English suitable for a permanent job record that other staff and customers may read.

Rules:
- Fix grammar, punctuation, and capitalisation.
- Remove filler words and voice-to-text artifacts ("um", "uh", "so basically", repeated words, false starts).
- Keep all factual details exactly as given: measurements, part numbers, brand names, prices, times, dates, customer/site names. Never invent, guess, or embellish details that weren't stated.
- Correctly recognise plumbing and hydraulic trade terminology (e.g. "backflow", "RPZ valve", "TMV", "PRV", "DN" pipe sizes, "trap", "vent stack", "floor waste", "cross-connection") and fix any voice-to-text mangling of these terms back to the correct spelling — but never substitute a different term than what was clearly intended, and never invent trade terms that weren't implied.
- Keep the tone plain and factual, not flowery or salesy.
- Keep it roughly the same length and keep the same meaning — polish it, don't rewrite it. Don't pad it out or add new sentences.
- Return only the rewritten note text, with no preamble, quotes, or labels.`;

// Calls Claude with the shared system prompt and returns the polished text.
// Throws on any failure (API error, refusal, empty result) — callers decide
// how to degrade.
//
// Haiku handles a short copy-edit well at a fraction of Opus's price. Haiku
// has no server-side refusal fallback, so a declined note is retried once on
// Opus instead.
const POLISH_MODEL = "claude-haiku-5-5";

// Job notes are a few sentences; this cap stops a signed-in user sending
// arbitrarily large text through a paid API.
export const POLISH_MAX_CHARS = 5000;
const REFUSAL_FALLBACK_MODEL = "claude-opus-5-5";

let client: Anthropic | null = null;

async function polishWith(model: Anthropic.Model, text: string): Promise<Anthropic.Message> {
  // Lazily constructed so a missing ANTHROPIC_API_KEY surfaces as a request
  // error rather than crashing module load for every route that imports this.
  client ??= new Anthropic();
  return client.messages.create({
    model,
    max_tokens: 4000,
    // A light copy-edit: low effort keeps it fast and cheap.
    output_config: { effort: "low" },
    system: POLISH_SYSTEM_PROMPT,
    messages: [{ role: "user", content: text }],
  });
}

export async function polishNoteText(text: string): Promise<string> {
  let response = await polishWith(POLISH_MODEL, text);
  if (response.stop_reason === "refusal") response = await polishWith(REFUSAL_FALLBACK_MODEL, text);

  if (response.stop_reason === "refusal") throw new Error("AI polish was declined");
  const polished = response.content
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("")
    .trim();
  if (!polished) throw new Error("AI polish returned no result");
  return polished;
}
