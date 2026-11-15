import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireUser } from "@/lib/api/guards";
import { reportError } from "@/lib/monitoring";
import { isOnJob } from "@/lib/builder-po-stages";

// Mark a stage of the job complete (0095; Justin, 4 Nov 2026), from the phone's
// Finish for today screen or the web PO tab. The phone sends this through its
// offline outbox, so a stage finished with no signal lands when signal returns,
// stamped with when it was tapped (completedAt, if sane).
//
// Retries are harmless: a stage already complete keeps its first stamp. Only
// the office can reopen one ({ reopen: true }). Every refusal answers 400/403,
// never 404 — the outbox retries a 404 forever.

const MAX_BACKDATE_MS = 14 * 86_400_000;

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string; stageId: string }> }) {
  const guard = await requireUser(request);
  if (!guard.ok) return guard.response;
  const { id: jobId, stageId } = await params;
  const b = ((await request.json().catch(() => null)) ?? {}) as Record<string, unknown>;
  const isOffice = guard.role === "office" || guard.role === "admin";

  try {
    const admin = createAdminClient();
    const onJob = await isOnJob(admin, jobId, guard.userId, guard.role);
    if (onJob === null) return NextResponse.json({ error: "Job not found" }, { status: 400 });
    if (!onJob) return NextResponse.json({ error: "Only the crew on this job can complete its stages." }, { status: 403 });

    const { data: stage } = await admin
      .from("po_cost_centers")
      .select("id, completed_at, purchase_orders!inner(job_id)")
      .eq("id", stageId)
      .eq("purchase_orders.job_id", jobId)
      .maybeSingle();
    if (!stage) return NextResponse.json({ error: "That stage isn't on this job." }, { status: 400 });

    if (b.reopen === true) {
      if (!isOffice) return NextResponse.json({ error: "Only the office can reopen a stage." }, { status: 403 });
      const { error } = await admin.from("po_cost_centers").update({ completed_at: null, completed_by: null }).eq("id", stageId);
      if (error) throw error;
      return NextResponse.json({ completedAt: null });
    }

    if (stage.completed_at) return NextResponse.json({ completedAt: stage.completed_at });

    const tapped = typeof b.completedAt === "string" ? Date.parse(b.completedAt) : NaN;
    const now = Date.now();
    const completedAt = new Date(Number.isFinite(tapped) && tapped <= now && now - tapped <= MAX_BACKDATE_MS ? tapped : now).toISOString();
    const { error } = await admin
      .from("po_cost_centers")
      .update({ completed_at: completedAt, completed_by: guard.userId })
      .eq("id", stageId)
      .is("completed_at", null);
    if (error) throw error;
    return NextResponse.json({ completedAt });
  } catch (err) {
    console.error("stage complete error:", err);
    reportError(err, { route: "api/jobs/stages/complete" });
    return NextResponse.json({ error: "Couldn't mark the stage complete. Try again." }, { status: 500 });
  }
}
