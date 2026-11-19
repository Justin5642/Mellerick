import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/api/guards";
import { callerClient } from "@/lib/api/caller-client";
import { reportError } from "@/lib/monitoring";

// Delete a job — admin only, on the web (components/job/delete-job-dialog.tsx)
// and the phone (job screen → Update job → Delete job). It used to be a browser
// write; it is a route so both apps share one guard and the same sentences.
//
// The delete runs as the CALLER (callerClient), never the service role, so RLS
// still decides: 0049's restrictive "only office/admin may delete a job" stays
// the backstop behind requireAdmin.
//
// Deleting cascades in the database to the job's notes, photos, documents,
// time entries, expenses and variations. Quotes and invoices reference jobs
// with no delete action, so Postgres refuses a job that has one (23503) — that
// is answered with the sentence the dialog has always shown.

const JOB_HAS_QUOTE_OR_INVOICE =
  "This job has a linked quote or invoice — remove or unlink that first, then delete the job.";

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireAdmin(request);
  if (!guard.ok) return guard.response;
  const { id: jobId } = await params;

  try {
    const supabase = await callerClient(request);
    const { error, count } = await supabase.from("jobs").delete({ count: "exact" }).eq("id", jobId);
    if (error) {
      if (error.code === "23503") return NextResponse.json({ error: JOB_HAS_QUOTE_OR_INVOICE }, { status: 409 });
      throw error;
    }
    if (!count) return NextResponse.json({ error: "Job not found — it may already have been deleted." }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("delete job error:", err);
    reportError(err, { route: "api/jobs/delete" });
    return NextResponse.json({ error: "Couldn't delete the job. Try again." }, { status: 500 });
  }
}
