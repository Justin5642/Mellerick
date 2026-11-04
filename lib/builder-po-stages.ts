import type { createAdminClient } from "@/lib/supabase/admin";

// A job's stages — the lines of its builder PO (po_cost_centers) — and which
// are complete (0095 — DRAFT, not applied yet). Multi-day jobs (Justin, 4 Nov 2026): the crew mark a
// stage done from site so the office can claim it, while the job stays open.
//
// No money here: the crew read this through the service role, so it selects
// names and completion only, field by field.

type Admin = ReturnType<typeof createAdminClient>;

export interface JobStage {
  id: string;
  name: string;
  costCentre: string | null;
  poNumber: string;
  completedAt: string | null;
  completedBy: string | null;
}

/** Office/admin, the job's lead, or anyone on its crew. */
export async function isOnJob(admin: Admin, jobId: string, userId: string, role: string | null): Promise<boolean | null> {
  const { data: job } = await admin.from("jobs").select("id, assigned_to").eq("id", jobId).maybeSingle();
  if (!job) return null;
  if (role === "office" || role === "admin" || job.assigned_to === userId) return true;
  const { data: crew } = await admin
    .from("job_assignments")
    .select("job_id")
    .eq("job_id", jobId)
    .eq("staff_id", userId)
    .maybeSingle();
  return !!crew;
}

export async function listJobStages(admin: Admin, jobId: string): Promise<JobStage[]> {
  const { data, error } = await admin
    .from("po_cost_centers")
    .select(
      "id, name, sort_order, completed_at, cost_centres(name), purchase_orders!inner(job_id, po_number), profiles!po_cost_centers_completed_by_fkey(full_name)"
    )
    .eq("purchase_orders.job_id", jobId);
  if (error) throw error;
  type Row = {
    id: string;
    name: string;
    sort_order: number | null;
    completed_at: string | null;
    cost_centres: { name: string } | null;
    purchase_orders: { po_number: string } | null;
    profiles: { full_name: string } | null;
  };
  return ((data ?? []) as unknown as Row[])
    .slice()
    .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
    .map((r) => ({
      id: r.id,
      name: r.name,
      costCentre: r.cost_centres?.name ?? null,
      poNumber: r.purchase_orders?.po_number ?? "",
      completedAt: r.completed_at,
      completedBy: r.completed_at ? r.profiles?.full_name ?? null : null,
    }));
}
