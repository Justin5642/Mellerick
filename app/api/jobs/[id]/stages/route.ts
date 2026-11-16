import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireOnJob } from "@/lib/api/guards";
import { reportError } from "@/lib/monitoring";
import { listJobStages } from "@/lib/builder-po-stages";

// The job's stages and which are complete, for the phone's Finish for today
// screen (lib/builder-po-stages.ts).
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: jobId } = await params;
  // requireOnJob reads the caller's role; requireUser left it null, so office
  // staff not on the crew were refused.
  const guard = await requireOnJob(request, jobId);
  if (!guard.ok) return guard.response;

  try {
    const admin = createAdminClient();
    return NextResponse.json({ stages: await listJobStages(admin, jobId) });
  } catch (err) {
    console.error("job stages error:", err);
    reportError(err, { route: "api/jobs/stages" });
    return NextResponse.json({ error: "Couldn't load the job's stages. Try again." }, { status: 500 });
  }
}
