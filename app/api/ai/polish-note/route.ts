import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

// Cleans up rough, often voice-dictated technician job notes into clear,
// professional wording before they're saved to the job's permanent record.
// Uses the same "call OpenAI directly via fetch with OPENAI_API_KEY" pattern
// as app/api/jobs/[id]/transcribe-voice-report/route.ts — no SDK needed.
const SYSTEM_PROMPT = `You clean up plumbing technician job notes that are often dictated via voice-to-text on a phone. Rewrite the note so it reads as clear, professional, concise English suitable for a permanent job record that other staff and customers may read.

Rules:
- Fix grammar, punctuation, and capitalisation.
- Remove filler words and voice-to-text artifacts ("um", "uh", "so basically", repeated words, false starts).
- Keep all factual details exactly as given: measurements, part numbers, brand names, prices, times, dates, customer/site names. Never invent, guess, or embellish details that weren't stated.
- Keep the tone plain and factual, not flowery or salesy.
- Keep it roughly the same length — don't pad it out or add new sentences.
- Return only the rewritten note text, with no preamble, quotes, or labels.`;

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  if (!process.env.OPENAI_API_KEY) {
    return NextResponse.json({ error: "OPENAI_API_KEY is not configured on the server" }, { status: 500 });
  }

  const body = await request.json().catch(() => ({}));
  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (!text) return NextResponse.json({ error: "text is required" }, { status: 400 });

  try {
    const openaiRes = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        temperature: 0.3,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: text },
        ],
      }),
    });

    if (!openaiRes.ok) {
      const errText = await openaiRes.text().catch(() => "");
      console.error("OpenAI polish-note error:", openaiRes.status, errText);
      return NextResponse.json({ error: "AI polish failed" }, { status: 502 });
    }

    const data = await openaiRes.json();
    const polished: string | undefined = data.choices?.[0]?.message?.content?.trim();
    if (!polished) return NextResponse.json({ error: "AI polish returned no result" }, { status: 502 });

    return NextResponse.json({ polished });
  } catch (err: any) {
    console.error("Polish note error:", err);
    return NextResponse.json({ error: err.message ?? "AI polish failed" }, { status: 500 });
  }
}
