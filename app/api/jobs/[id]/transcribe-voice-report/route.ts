import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

// Uses the service-role key (not the cookie-based server client) because
// this route is called from the mobile app with no browser session/cookies
// — same pattern as app/api/staff/invite. It needs guaranteed read access
// to the private job-audio bucket and write access to jobs regardless of
// caller auth state.
function getAdminClient() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  if (!process.env.OPENAI_API_KEY) {
    return NextResponse.json({ error: "OPENAI_API_KEY is not configured on the server" }, { status: 500 });
  }

  let body: { storagePath?: string; recordedBy?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { storagePath, recordedBy } = body;
  if (!storagePath) {
    return NextResponse.json({ error: "storagePath is required" }, { status: 400 });
  }

  const supabase = getAdminClient();

  try {
    const { data: audioBlob, error: downloadError } = await supabase.storage.from("job-audio").download(storagePath);
    if (downloadError || !audioBlob) {
      return NextResponse.json({ error: downloadError?.message ?? "Failed to download audio" }, { status: 404 });
    }

    const filename = storagePath.split("/").pop() ?? "voice-report.m4a";
    const openaiForm = new FormData();
    openaiForm.append("file", audioBlob, filename);
    openaiForm.append("model", "whisper-1");

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

    const { error: updateError } = await supabase
      .from("jobs")
      .update({
        voice_report_storage_path: storagePath,
        voice_report_transcript: transcript,
        voice_report_recorded_by: recordedBy ?? null,
        voice_report_recorded_at: new Date().toISOString(),
      })
      .eq("id", id);

    if (updateError) {
      return NextResponse.json({ error: updateError.message }, { status: 500 });
    }

    return NextResponse.json({ transcript });
  } catch (err: any) {
    console.error("Voice report transcription error:", err);
    return NextResponse.json({ error: err.message ?? "Transcription failed" }, { status: 500 });
  }
}
