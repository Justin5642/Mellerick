import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/api/guards";
import { canManageJobBilling } from "@/lib/api/job-authz";
import { createAdminClient } from "@/lib/supabase/admin";
import { reportError } from "@/lib/monitoring";

// Saves a job's voice report. The phone sends it in two independent calls
// (mobile/lib/data/repositories/voiceReport.ts):
//
//   { transcript }   the words — saved even if the audio never uploads; also
//                    clears the recording path, which belonged to the previous
//                    report until the new audio (if any) is attached.
//   { storagePath }  the recording in the private job-audio bucket, once it
//                    has uploaded. Touches only the path.
//
// The transcript is produced ON THE PHONE (mobile/lib/dictation.ts — Apple /
// Google speech recognition). This route used to download the audio and send
// it to OpenAI Whisper; that is gone, so nothing is transcribed here any more.
// The path keeps its old name because queued outbox operations on technicians'
// phones still call it — an old-format { storagePath } call now just attaches
// the recording.
//
// Uses the service-role key (not the cookie-based server client) because the
// mobile app calls it with a Bearer token and it writes jobs.voice_report_*,
// which technicians cannot update directly. The service-role key bypasses RLS,
// so this route verifies the caller and their claim on the job itself.
const getAdminClient = createAdminClient;

// A spoken job summary is a few hundred words; this stops a signed-in user
// storing arbitrarily large text on a job row.
const VOICE_REPORT_MAX_CHARS = 20_000;

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  // Shared helper: accepts the mobile Bearer token AND the browser cookie
  // session, and refuses a deactivated profile.
  const guard = await requireUser(request);
  if (!guard.ok) return guard.response;
  const callerId = guard.userId;

  let body: { storagePath?: unknown; transcript?: unknown; recordedBy?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  // `recordedBy` is deliberately NOT read from the body. See the update below.
  const storagePath = typeof body.storagePath === "string" && body.storagePath ? body.storagePath : null;
  const transcript = typeof body.transcript === "string" ? body.transcript.trim() : null;

  if (!storagePath && !transcript) {
    return NextResponse.json({ error: "transcript or storagePath is required" }, { status: 400 });
  }
  if (transcript && transcript.length > VOICE_REPORT_MAX_CHARS) {
    return NextResponse.json({ error: `Voice report is too long (max ${VOICE_REPORT_MAX_CHARS} characters)` }, { status: 413 });
  }

  // The path is stored on the job and later read under the service-role key,
  // so a client-supplied path must be pinned to THIS job. The recorder always
  // uploads to `${jobId}/...` (mobile/lib/data/repositories/voiceReport.ts).
  if (storagePath && (!storagePath.startsWith(`${id}/`) || storagePath.includes(".."))) {
    return NextResponse.json({ error: "storagePath does not belong to this job" }, { status: 403 });
  }

  const supabase = getAdminClient();

  // MEMBERSHIP. The update below runs under the service-role key, which bypasses
  // RLS, and targets `.eq("id", id)` — so without this, ANY authenticated user
  // could replace ANY job's transcript and audio path. Same policy as the
  // billing routes — office/admin, or a technician assigned to the job.
  if (!(await canManageJobBilling(supabase, callerId, id))) {
    return NextResponse.json({ error: "Not authorized for this job" }, { status: 403 });
  }

  try {
    const { error: updateError } = await supabase
      .from("jobs")
      .update(
        transcript
          ? {
              voice_report_transcript: transcript,
              voice_report_storage_path: storagePath,
              // The AUTHENTICATED caller, never the request body. A voice report
              // is a record of who said what on a job; letting the sender choose
              // the author makes it worthless as evidence.
              voice_report_recorded_by: callerId,
              voice_report_recorded_at: new Date().toISOString(),
            }
          : { voice_report_storage_path: storagePath }
      )
      .eq("id", id);

    if (updateError) {
      console.error("Voice report job update failed:", updateError.message);
      return NextResponse.json({ error: "Saving the voice report failed" }, { status: 500 });
    }

    return NextResponse.json({ transcript: transcript || null });
  } catch (err: unknown) {
    console.error("Voice report save error:", err);
    reportError(err, { route: "api/jobs/transcribe-voice-report" });
    return NextResponse.json({ error: "Saving the voice report failed" }, { status: 500 });
  }
}
