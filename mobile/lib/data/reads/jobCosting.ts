// DELIBERATELY SUPABASE-ONLY — no fromLocalOr / LocalReads path in this module.
// staff_cost_profiles and billing_rate_config are excluded from the PowerSync
// publication (migration 0039), so they never exist on-device. 8 of the 10
// queries below could be served locally, but minMarginPct (billing_rate_config)
// drives the belowMinMargin verdict — defaulting it offline would silently
// change a money verdict. Pinned by supabaseOnly.test.ts.

import { supabase } from "../../supabase";
import { unwrap, unwrapRows } from "./unwrap";
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

  const job = unwrap(jobRes as never, "getJobProfitability(job)") as unknown as { job_number: number | null; title: string } | null;
  if (!job) return null;
  const cfg = unwrap(cfgRes as never, "getJobProfitability(billingRateConfig)") as unknown as { min_margin_pct: number | null } | null;
  const minMarginPct = cfg?.min_margin_pct != null ? Number(cfg.min_margin_pct) : 30;

  const result = computeJobProfitability({
    timeEntries: unwrapRows(timeRes as never, "getJobProfitability(timeEntries)") as unknown as { staff_id: string; hours: number | null }[],
    staffCostProfiles: unwrapRows(profilesRes as never, "getJobProfitability(staffCostProfiles)") as unknown as StaffCostProfile[],
    expenses: unwrapRows(expensesRes as never, "getJobProfitability(jobExpenses)") as unknown as { amount: number | null }[],
    equipmentUsage: unwrapRows(usageRes as never, "getJobProfitability(equipmentUsage)") as unknown as { equipment_id: string; hours: number }[],
    equipmentOptions: unwrapRows(equipRes as never, "getJobProfitability(equipment)") as unknown as EquipmentOption[],
    invoices: unwrapRows(invoicesRes as never, "getJobProfitability(invoices)") as unknown as { subtotal: number | null; status: string }[],
    jobItems: unwrapRows(itemsRes as never, "getJobProfitability(jobItems)") as unknown as { total: number | null }[],
    variations: unwrapRows(varsRes as never, "getJobProfitability(variations)") as unknown as { status: string; invoice_id: string | null; total_amount: number | null }[],
    minMarginPct,
  });
  return { ...result, jobNumber: job.job_number, jobTitle: job.title };
}
