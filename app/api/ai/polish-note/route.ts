import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/api/guards";
import { polishNoteText, POLISH_MAX_CHARS } from "@/lib/ai/polish-note";
import { reportError, reportFailure } from "@/lib/monitoring";
import { consumeRateLimit, rateLimitedResponse, POLISH_NOTE_LIMIT } from "@/lib/api/rate-limit";

// Cleans up rough, often voice-dictated technician job notes into clear,
// professional wording before they're saved to the job's permanent record.
// The prompt + Claude call live in lib/ai/polish-note.ts. "Record note"
// dictation (on the phone or in the browser) calls this same route after
// recognition, so typed and dictated notes polish identically.

// Called both from the web dashboard (cookie-based session, handled by
// lib/supabase/server) and from the mobile app (no cookies — instead
// attaches its Supabase session access token as a Bearer header). Same
// dual-path auth as app/api/jobs/[id]/transcribe-voice-report/route.ts.
// requireUser: Bearer token (mobile) or cookie (web), and refuses a
// deactivated profile.
async function getAuthenticatedUserId(request: NextRequest): Promise<string | null> {
  const guard = await requireUser(request);
  return guard.ok ? guard.userId : null;
}

export async function POST(request: NextRequest) {
  const userId = await getAuthenticatedUserId(request);
  if (!userId) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  if (!process.env.ANTHROPIC_API_KEY) {
    reportFailure("ANTHROPIC_API_KEY is not configured", { route: "api/ai/polish-note", integration: "anthropic" });
    return NextResponse.json({ error: "ANTHROPIC_API_KEY is not configured on the server" }, { status: 500 });
  }

  const body = await request.json().catch(() => ({}));
  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (!text) return NextResponse.json({ error: "text is required" }, { status: 400 });
  if (text.length > POLISH_MAX_CHARS) {
    return NextResponse.json({ error: `Note is too long to polish (max ${POLISH_MAX_CHARS.toLocaleString()} characters).` }, { status: 413 });
  }

  // Shared across instances (lib/api/rate-limit.ts); counted only once the
  // request is valid and about to cost money.
  if (!(await consumeRateLimit(userId, POLISH_NOTE_LIMIT))) {
    return rateLimitedResponse();
  }

  try {
    const polished = await polishNoteText(text);
    return NextResponse.json({ polished });
  } catch (err: unknown) {
    console.error("Polish note error:", err);
    reportError(err, { route: "api/ai/polish-note", integration: "anthropic" });
    return NextResponse.json({ error: "AI polish failed" }, { status: 502 });
  }
}
