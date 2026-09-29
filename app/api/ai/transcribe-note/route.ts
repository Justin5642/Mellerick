import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/api/guards";
import { polishNoteText, TRANSCRIBE_TRADE_TERM_PROMPT } from "@/lib/ai/polish-note";

// Voice-to-text for job notes (currently used by the stage-notes composer on
// both platforms): a tech records a short clip in-app, it's uploaded here as
// multipart form-data, transcribed via OpenAI Whisper, then run through the
// SAME polish pass as /api/ai/polish-note so a dictated note reads the same
// as a typed-then-polished one. Returns one ready-to-save string — the
// client just drops it into the note field; the tech glances at it and taps
// Save, or edits first. Nothing is auto-saved and no audio is persisted
// (unlike the job-level voice report in
// app/api/jobs/[id]/transcribe-voice-report/route.ts, which keeps the
// recording in the job-audio bucket as a permanent record — a stage note's
// record is the text itself, so the clip is discarded once transcribed).
//
// Just requireUser, not a per-job authorization check: this route doesn't
// read or write any job row (the actual note insert happens client-side
// through ordinary RLS-guarded writes), so all it needs to confirm is that
// the caller is a logged-in staff member, same bar as /api/ai/polish-note.
export async function POST(request: NextRequest) {
  const guard = await requireUser(request);
  if (!guard.ok) return guard.response;

  if (!process.env.OPENAI_API_KEY) {
    return NextResponse.json({ error: "OPENAI_API_KEY is not configured on the server" }, { status: 500 });
  }

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return NextResponse.json({ error: "Expected multipart/form-data with an audio field" }, { status: 400 });
  }

  const audio = formData.get("audio");
  if (!(audio instanceof Blob) || audio.size === 0) {
    return NextResponse.json({ error: "audio is required" }, { status: 400 });
  }

  try {
    const openaiForm = new FormData();
    openaiForm.append("file", audio, "note.m4a");
    openaiForm.append("model", "whisper-1");
    // Decoding context only (not instructions) — biases Whisper toward the
    // trade vocabulary a plumbing job note is likely to contain, so terms
    // like "RPZ" or "TMV" are less likely to come out mangled in the first
    // place, before the polish pass even runs.
    openaiForm.append("prompt", TRANSCRIBE_TRADE_TERM_PROMPT);

    const openaiRes = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      body: openaiForm,
    });

    if (!openaiRes.ok) {
      const errText = await openaiRes.text().catch(() => "");
      console.error("OpenAI transcription error:", openaiRes.status, errText);
      return NextResponse.json({ error: "Transcription failed" }, { status: 502 });
    }

    const { text: transcript } = (await openaiRes.json()) as { text: string };
    if (!transcript?.trim()) {
      return NextResponse.json({ error: "Didn't catch any speech — try again." }, { status: 422 });
    }

    // Polish is a best-effort second pass, not a required one: a raw-but-
    // correct transcript is still a usable note, and failing the whole
    // request here would throw away a transcription that worked fine.
    try {
      const polished = await polishNoteText(transcript.trim());
      return NextResponse.json({ text: polished });
    } catch (polishErr) {
      console.error("Transcribe-note polish step failed, falling back to raw transcript:", polishErr);
      return NextResponse.json({ text: transcript.trim() });
    }
  } catch (err: any) {
    console.error("Transcribe note error:", err);
    return NextResponse.json({ error: err.message ?? "Transcription failed" }, { status: 500 });
  }
}
