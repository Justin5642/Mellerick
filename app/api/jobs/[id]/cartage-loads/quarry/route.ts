import { NextRequest, NextResponse } from "next/server";
import { requireOfficeOrAdmin } from "@/lib/api/guards";
import { callerClient } from "@/lib/api/caller-client";
import { reportError } from "@/lib/monitoring";
import { loadTruckLoads } from "@/lib/cartage-load";
import { isUuid } from "@/lib/day-works-entry";
import { parseQuarryBody } from "@/lib/day-works-office";

// "Quarry product on this job" (jobs.quarry_included, 0111): included in the
// quote (true / null = the default) or extra (false). Office/admin only — the
// route guard here, and 0111's jobs_quarry_included_guard trigger refuses
// anyone else whatever the client. Written with the CALLER's client. Answers
// with the fresh Truck loads section (new loads' defaults follow it).

type Ctx = { params: Promise<{ id: string }> };

export async function PUT(request: NextRequest, { params }: Ctx) {
  const { id: jobId } = await params;
  const guard = await requireOfficeOrAdmin(request);
  if (!guard.ok) return guard.response;
  if (!isUuid(jobId)) return NextResponse.json({ error: "Job not found" }, { status: 404 });

  const parsed = parseQuarryBody(await request.json().catch(() => null));
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });

  try {
    const supabase = await callerClient(request);
    const { error, count } = await supabase.from("jobs").update({ quarry_included: parsed.quarryIncluded }, { count: "exact" }).eq("id", jobId);
    if (error) {
      if (error.code === "42501") return NextResponse.json({ error: "Couldn't change it. Only the office can." }, { status: 403 });
      throw error;
    }
    if (count === 0) return NextResponse.json({ error: "Job not found" }, { status: 404 });

    return NextResponse.json(await loadTruckLoads(request, jobId, { userId: guard.userId, isOffice: true }));
  } catch (err) {
    console.error("quarry default error:", err);
    reportError(err, { route: "api/jobs/cartage-loads/quarry" });
    return NextResponse.json({ error: "Couldn't change it. Try again." }, { status: 500 });
  }
}
