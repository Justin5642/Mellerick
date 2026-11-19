// The website's reads and the one write behind a booking's cost centre picker
// (19 Nov 2026 — bookings always ask for a cost centre). Rules are in
// lib/booking-cost-centre.ts. Office/admin screens only: po_cost_centers and
// purchase_orders are office/admin by RLS. Names and ids only — no money is
// selected here.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { BookingLineOption, CompanyCostCentreOption } from "./booking-cost-centre";

export interface BookingCostCentreOptions {
  /** The job's PO lines, first PO first. */
  lines: BookingLineOption[];
  /** The company's active cost centres. */
  company: CompanyCostCentreOption[];
  /** jobs.scheduled_cost_center_id — a default for a new booking. */
  scheduled: string | null;
}

type RawPo = {
  po_number: string;
  po_cost_centers: { id: string; name: string; cost_centre_id: string | null; sort_order: number | null }[] | null;
};

/** Reads what the picker offers for one job. A failed read leaves that part empty. */
export async function loadBookingCostCentreOptions(supabase: SupabaseClient, jobId: string): Promise<BookingCostCentreOptions> {
  const [posRes, centresRes, jobRes] = await Promise.all([
    supabase
      .from("purchase_orders")
      .select("po_number, po_cost_centers(id, name, cost_centre_id, sort_order)")
      .eq("job_id", jobId)
      .order("created_at"),
    supabase.from("cost_centres").select("id, name").eq("is_active", true).order("sort_order"),
    supabase.from("jobs").select("scheduled_cost_center_id").eq("id", jobId).maybeSingle(),
  ]);
  if (posRes.error) console.error("booking cost centres: PO lines read failed:", posRes.error);
  if (centresRes.error) console.error("booking cost centres: company list read failed:", centresRes.error);
  const lines = ((posRes.data ?? []) as unknown as RawPo[]).flatMap((po) =>
    [...(po.po_cost_centers ?? [])]
      .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
      .map((l) => ({ id: l.id, name: l.name, cost_centre_id: l.cost_centre_id, po_number: po.po_number })),
  );
  return {
    lines,
    company: ((centresRes.data ?? []) as CompanyCostCentreOption[]).map((c) => ({ id: c.id, name: c.name })),
    scheduled: (jobRes.data as { scheduled_cost_center_id: string | null } | null)?.scheduled_cost_center_id ?? null,
  };
}

/** The company list alone (the Schedule dialog already has the job's lines). */
export async function loadCompanyCostCentres(supabase: SupabaseClient): Promise<CompanyCostCentreOption[]> {
  const { data, error } = await supabase.from("cost_centres").select("id, name").eq("is_active", true).order("sort_order");
  if (error) console.error("booking cost centres: company list read failed:", error);
  return ((data ?? []) as CompanyCostCentreOption[]).map((c) => ({ id: c.id, name: c.name }));
}

/**
 * Adds a company cost centre to the job as a $0 PO line (or finds the line it
 * already has) — POST /api/jobs/[id]/booking-cost-centre, run as the signed-in
 * office user. The answer's error is the route's own sentence.
 */
export async function addCostCentreToJob(
  jobId: string,
  costCentreId: string,
): Promise<{ ok: true; line: Required<BookingLineOption>; added: boolean } | { ok: false; error: string }> {
  try {
    const res = await fetch(`/api/jobs/${encodeURIComponent(jobId)}/booking-cost-centre`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ costCentreId }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data?.line?.id) return { ok: false, error: data?.error ?? "Couldn't add the cost centre to this job. Try again." };
    return { ok: true, line: data.line, added: !!data.added };
  } catch {
    return { ok: false, error: "Couldn't reach the server to add the cost centre. Try again." };
  }
}
