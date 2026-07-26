import { supabase } from "../../supabase";
import { computeJobProfitability, type JobProfitabilityResult, type StaffCostProfile, type EquipmentOption } from "../../costing";

export interface JobProfitabilityData extends JobProfitabilityResult {
  jobNumber: number | null;
  jobTitle: string;
}

// Admin-only job profitability read. Mirrors the web page's queries
// (app/dashboard/jobs/[id]/page.tsx) then runs the pure rollup. Payroll-
// sensitive (staff_cost_profiles) — the route is admin-gated.
export async function getJobProfitability(jobId: string): Promise<JobProfitabilityData | null> {
  const [jobRes, timeRes, profilesRes, expensesRes, equipRes, usageRes, invoicesRes, itemsRes, varsRes, cfgRes] = await Promise.all([
    supabase.from("jobs").select("job_number, title").eq("id", jobId).single(),
    supabase.from("time_entries").select("staff_id, hours").eq("job_id", jobId),
    supabase.from("staff_cost_profiles").select("*"),
    supabase.from("job_expenses").select("amount").eq("job_id", jobId),
    supabase.from("equipment").select("*").eq("is_active", true),
    supabase.from("equipment_usage_log").select("equipment_id, hours").eq("job_id", jobId),
    supabase.from("invoices").select("subtotal, status").eq("job_id", jobId),
    supabase.from("job_items").select("total").eq("job_id", jobId),
    supabase.from("job_variations").select("status, invoice_id, total_amount").eq("job_id", jobId),
    supabase.from("billing_rate_config").select("min_margin_pct").eq("id", true).maybeSingle(),
  ]);

  const job = jobRes.data as { job_number: number | null; title: string } | null;
  if (!job) return null;
  const cfg = cfgRes.data as { min_margin_pct: number | null } | null;
  const minMarginPct = cfg?.min_margin_pct != null ? Number(cfg.min_margin_pct) : 30;

  const result = computeJobProfitability({
    timeEntries: (timeRes.data as unknown as { staff_id: string; hours: number | null }[]) ?? [],
    staffCostProfiles: (profilesRes.data as unknown as StaffCostProfile[]) ?? [],
    expenses: (expensesRes.data as unknown as { amount: number | null }[]) ?? [],
    equipmentUsage: (usageRes.data as unknown as { equipment_id: string; hours: number }[]) ?? [],
    equipmentOptions: (equipRes.data as unknown as EquipmentOption[]) ?? [],
    invoices: (invoicesRes.data as unknown as { subtotal: number | null; status: string }[]) ?? [],
    jobItems: (itemsRes.data as unknown as { total: number | null }[]) ?? [],
    variations: (varsRes.data as unknown as { status: string; invoice_id: string | null; total_amount: number | null }[]) ?? [],
    minMarginPct,
  });
  return { ...result, jobNumber: job.job_number, jobTitle: job.title };
}
