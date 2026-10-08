import Anthropic from "@anthropic-ai/sdk";

// Shared helpers for turning technician-dictated text into clean job-record
// prose. The polish pass runs on Claude; Whisper (OpenAI) is still used only
// for audio transcription in /api/ai/transcribe-note. Used by both /api/ai/polish-note (cleans up text the tech
// already typed or dictated via the OS keyboard) and /api/ai/transcribe-note
// (records audio in-app, transcribes via Whisper, then runs the SAME polish
// pass) so the two paths can never drift apart on wording rules — a note
// should read the same regardless of which input path produced it.

export const POLISH_SYSTEM_PROMPT = `You clean up plumbing technician job notes that are often dictated via voice-to-text on a phone. Rewrite the note so it reads as clear, professional, concise English suitable for a permanent job record that other staff and customers may read.

Rules:
- Fix grammar, punctuation, and capitalisation.
- Remove filler words and voice-to-text artifacts ("um", "uh", "so basically", repeated words, false starts).
- Keep all factual details exactly as given: measurements, part numbers, brand names, prices, times, dates, customer/site names. Never invent, guess, or embellish details that weren't stated.
- Correctly recognise plumbing and hydraulic trade terminology (e.g. "backflow", "RPZ valve", "TMV", "PRV", "DN" pipe sizes, "trap", "vent stack", "floor waste", "cross-connection") and fix any voice-to-text mangling of these terms back to the correct spelling — but never substitute a different term than what was clearly intended, and never invent trade terms that weren't implied.
- Keep the tone plain and factual, not flowery or salesy.
- Keep it roughly the same length and keep the same meaning — polish it, don't rewrite it. Don't pad it out or add new sentences.
- Return only the rewritten note text, with no preamble, quotes, or labels.`;

// Passed as Whisper's optional `prompt` param on the transcription request
// (not the chat prompt above) to bias its decoding toward the trade
// vocabulary a plumbing job note is likely to contain, so terms like "RPZ"
// or "TMV" are less likely to come out as a garbled homophone in the first
// place. Whisper uses this as decoding context, not as instructions.
export const TRANSCRIBE_TRADE_TERM_PROMPT =
  "Plumbing and hydraulic services job note, dictated by a technician on site. May include terms such as: backflow, backflow prevention, RPZ valve, reduced pressure zone, testable, non-testable, double check valve, air gap, DN15, DN20, DN25, DN32, DN40, DN50, PRV, pressure limiting valve, TMV, tempering valve, thermostatic mixing valve, trap, floor waste, gully trap, inspection point, vent stack, stack, cross-connection, water hammer, expansion valve, hydraulic, isolation valve, stop tap, rough-in, fit-off.";

// Calls Claude with the shared system prompt and returns the polished text.
// Throws on any failure (API error, refusal, empty result) — callers decide
// how to degrade (transcribe-note falls back to the raw transcript rather
// than failing the whole request).
const POLISH_MODEL = "claude-opus-5-5";

let client: Anthropic | null = null;

export async function polishNoteText(text: string): Promise<string> {
  // Lazily constructed so a missing ANTHROPIC_API_KEY surfaces as a request
  // error rather than crashing module load for every route that imports this.
  client ??= new Anthropic();
  const response = await client.beta.messages.create({
    model: POLISH_MODEL,
    max_tokens: 4000,
    // A light copy-edit: low effort keeps it fast and cheap.
    output_config: { effort: "low" },
    // On a safety decline, Anthropic re-runs the request on its recommended
    // fallback model instead of returning a refusal.
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    system: POLISH_SYSTEM_PROMPT,
    messages: [{ role: "user", content: text }],
  });

  if (response.stop_reason === "refusal") throw new Error("AI polish was declined");
  const polished = response.content
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("")
    .trim();
  if (!polished) throw new Error("AI polish returned no result");
  return polished;
}
