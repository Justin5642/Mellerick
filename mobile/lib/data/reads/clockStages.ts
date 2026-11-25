import { supabase } from "../../supabase";
import { officeApi } from "../../officeApi";
import { unwrapRows } from "./unwrap";
import type { ClockOnStage } from "../../bookings";

// Which of a job's stages (builder PO lines) are complete, for the clock-on
// (Justin, 25 Nov 2026: "it is critical that they clock on to the correct
// cost centre"). Completion is po_cost_centers.completed_at (0095); the table
// is office-only by RLS and in no technician stream, so both reads here are
// ONLINE and best-effort: null = not known, and every caller then behaves as
// it did before (lib/bookings.ts manualClockOnCostCentre / clockInCostCentre).
// Ids and dates only — never a name with an amount, never an amount.

/**
 * One job's stages with completion, for a manual clock-on: the web's
 * GET /api/jobs/[id]/stages (requireOnJob — the job's crew and office;
 * names and completion only). Null offline or on any failure.
 */
export interface ClockStage extends ClockOnStage {
  name: string;
  /** The company cost centre the line is tagged with, when it is. */
  costCentre: string | null;
}

export async function listJobClockStages(jobId: string): Promise<ClockStage[] | null> {
  try {
    const res = await officeApi<{ stages?: { id: string; name: string; costCentre: string | null; completedAt: string | null }[] }>(
      `/api/jobs/${jobId}/stages`
    );
    if (!Array.isArray(res.stages)) return null;
    return res.stages.map((s) => ({ id: s.id, name: s.name, costCentre: s.costCentre ?? null, completed_at: s.completedAt ?? null }));
  } catch {
    return null;
  }
}

/**
 * The completed stage ids of several jobs, for the auto-clock's sites and the
 * clock prompts: po_cost_centers_public.completed_at (added to the view by
 * 0118). Null before 0118, offline, or on any failure — the auto paths then
 * keep their old rule.
 */
export async function completedStageIdsByJob(jobIds: readonly string[]): Promise<Map<string, string[]> | null> {
  if (jobIds.length === 0) return new Map();
  try {
    const res = await supabase
      .from("purchase_orders_public")
      .select("job_id, po_cost_centers_public(id, completed_at)")
      .in("job_id", [...jobIds]);
    // unwrapRows throws on an error (before 0118: no completed_at column);
    // caught below and answered "not known".
    const rows = unwrapRows(res as never, "completedStageIdsByJob");
    const out = new Map<string, string[]>();
    for (const po of rows as unknown as { job_id: string; po_cost_centers_public: { id: string; completed_at: string | null }[] | null }[]) {
      const done = (po.po_cost_centers_public ?? []).filter((l) => !!l.completed_at).map((l) => l.id);
      out.set(po.job_id, [...(out.get(po.job_id) ?? []), ...done]);
    }
    return out;
  } catch {
    return null;
  }
}

/** Sites (or prompt jobs) with their job's completed stages attached, when known. Never throws. */
export async function withCompletedStages<S extends { jobId: string }>(
  items: S[]
): Promise<(S & { completedCostCentreIds?: string[] })[]> {
  if (items.length === 0) return items;
  const byJob = await completedStageIdsByJob([...new Set(items.map((s) => s.jobId))]);
  if (!byJob) return items;
  return items.map((s) => ({ ...s, completedCostCentreIds: byJob.get(s.jobId) ?? [] }));
}
