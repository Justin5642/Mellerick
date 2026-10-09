import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { polishNoteText, POLISH_MAX_CHARS } from "@/lib/ai/polish-note";
import { reportError, reportFailure } from "@/lib/monitoring";

// Cleans up rough, often voice-dictated technician job notes into clear,
// professional wording before they're saved to the job's permanent record.
// The prompt + Claude call live in lib/ai/polish-note.ts, shared with
// /api/ai/transcribe-note (record-in-app voice notes), so both input paths
// polish identically.

// Called both from the web dashboard (cookie-based session, handled by
// lib/supabase/server) and from the mobile app (no cookies — instead
// attaches its Supabase session access token as a Bearer header). Same
// dual-path auth as app/api/jobs/[id]/transcribe-voice-report/route.ts.
async function getAuthenticatedUserId(request: NextRequest) {
  const authHeader = request.headers.get("authorization") ?? "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice("Bearer ".length) : null;
  if (token) {
    const anonClient = createSupabaseClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const { data, error } = await anonClient.auth.getUser(token);
    return error || !data.user ? null : data.user.id;
  }
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  return user?.id ?? null;
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

  try {
    const polished = await polishNoteText(text);
    return NextResponse.json({ polished });
  } catch (err: any) {
    console.error("Polish note error:", err);
    reportError(err, { route: "api/ai/polish-note", integration: "anthropic" });
    return NextResponse.json({ error: err.message ?? "AI polish failed" }, { status: 502 });
  }
}
