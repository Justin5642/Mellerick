import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { getCallerId } from "@/lib/api/guards";
import { canManageJobBilling } from "@/lib/api/job-authz";

// Uses the service-role key (not the cookie-based server client) because
// this route is called from the mobile app with no browser session/cookies
// — same pattern as app/api/staff/invite. It needs guaranteed read access
// to the private job-audio bucket and write access to jobs regardless of
// caller auth state. Because the service-role key bypasses RLS entirely,
// this route must verify the caller's identity itself: the mobile app
// attaches its Supabase session access token as a Bearer header, which we
// validate against the anon-key client below before touching any data.
function getAdminClient() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  // Shared helper rather than a local copy: it accepts the mobile Bearer token
  // AND the browser cookie session, where the local version handled only Bearer.
  const callerId = await getCallerId(request);
  if (!callerId) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  if (!process.env.OPENAI_API_KEY) {
    return NextResponse.json({ error: "OPENAI_API_KEY is not configured on the server" }, { status: 500 });
  }

  let body: { storagePath?: string; recordedBy?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  // `recordedBy` is deliberately NOT read from the body. See the update below.
  const { storagePath } = body;
  if (!storagePath) {
    return NextResponse.json({ error: "storagePath is required" }, { status: 400 });
  }

  // The download below runs under the service-role key, which bypasses the
  // private job-audio bucket's RLS entirely -- so a client-supplied path
  // must be pinned to THIS job, or a caller could pass any path and read any
  // file in the bucket. The recorder always uploads to `${jobId}/...` (see
  // mobile/components/job/voice-report.tsx), so require that prefix and
  // reject any parent-directory traversal.
  if (!storagePath.startsWith(`${id}/`) || storagePath.includes("..")) {
    return NextResponse.json({ error: "storagePath does not belong to this job" }, { status: 403 });
  }

  const supabase = getAdminClient();

  // MEMBERSHIP. The update below runs under the service-role key, which bypasses
  // RLS, and targets `.eq("id", id)` — so without this, ANY authenticated user
  // could replace ANY job's transcript and audio path.
  //
  // This was easy to miss precisely because the route is guarded in one place
  // already: storagePath is pinned to the job, which stops a cross-job FILE
  // read. That partial guard made the route look protected while the WRITE was
  // open to everyone. Same policy as the billing routes — office/admin, or the
  // technician the job is assigned to.
  if (!(await canManageJobBilling(supabase, callerId, id))) {
    return NextResponse.json({ error: "Not authorized for this job" }, { status: 403 });
  }

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
        // The AUTHENTICATED caller, never the request body. A voice report is
        // a record of who said what on a job; letting the sender choose the
        // author makes it worthless as evidence and lets one technician
        // attribute a report to another.
        voice_report_recorded_by: callerId,
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
