import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireUser } from "@/lib/api/guards";
import { reportError } from "@/lib/monitoring";
import { isOnJob, listJobStages } from "@/lib/builder-po-stages";

// The job's stages and which are complete, for the phone's Finish for today
// screen (lib/builder-po-stages.ts).
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireUser(request);
  if (!guard.ok) return guard.response;
  const { id: jobId } = await params;

  try {
    const admin = createAdminClient();
    const onJob = await isOnJob(admin, jobId, guard.userId, guard.role);
    if (onJob === null) return NextResponse.json({ error: "Job not found" }, { status: 404 });
    if (!onJob) return NextResponse.json({ error: "Only the crew on this job can see its stages." }, { status: 403 });
    return NextResponse.json({ stages: await listJobStages(admin, jobId) });
  } catch (err) {
    console.error("job stages error:", err);
    reportError(err, { route: "api/jobs/stages" });
    return NextResponse.json({ error: "Couldn't load the job's stages. Try again." }, { status: 500 });
  }
}
