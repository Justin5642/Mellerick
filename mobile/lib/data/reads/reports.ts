import { supabase } from "../../supabase";
import { topCustomersBySpend, revenueByMonth, jobsByStaff, type InvoiceRow, type JobStaffRow } from "../../reportsAnalytics";
import { computeStaffEfficiency, type StaffEffProfile, type StaffEffRow, type StaffEffInput } from "../../staffEfficiency";
import { computeEquipmentUtilization, type EquipUtilRow, type EquipUtilInput } from "../../equipmentUtilization";

export interface ReportSummary {
  revenuePaid: number;
  outstanding: number;
  quotesAccepted: number;
  quotesDeclined: number;
  quotesTotal: number;
  jobsByStatus: { status: string; count: number }[];
  activeJobs: number;
}

const JOB_STATUSES = ["pending", "scheduled", "in_progress", "completed", "cancelled"] as const;

export async function getReportSummary(): Promise<ReportSummary> {
  const jobCountQueries = JOB_STATUSES.map((s) =>
    supabase.from("jobs").select("*", { count: "exact", head: true }).eq("status", s)
  );
  const [paidRes, outstandingRes, quotesRes, ...jobCounts] = await Promise.all([
    supabase.from("invoices").select("total").eq("status", "paid"),
    supabase.from("invoices").select("total").in("status", ["sent", "overdue"]),
    supabase.from("quotes").select("status"),
    ...jobCountQueries,
  ]);

  const sum = (rows: { total: number | null }[] | null) => (rows ?? []).reduce((s, r) => s + Number(r.total ?? 0), 0);
  const quotes = (quotesRes.data as { status: string }[] | null) ?? [];
  const jobsByStatus = JOB_STATUSES.map((status, i) => ({ status, count: jobCounts[i].count ?? 0 }));
  const activeJobs = jobsByStatus.filter((j) => ["pending", "scheduled", "in_progress"].includes(j.status)).reduce((s, j) => s + j.count, 0);

  return {
    revenuePaid: sum(paidRes.data as { total: number | null }[] | null),
    outstanding: sum(outstandingRes.data as { total: number | null }[] | null),
    quotesAccepted: quotes.filter((q) => q.status === "accepted").length,
    quotesDeclined: quotes.filter((q) => q.status === "declined").length,
    quotesTotal: quotes.length,
    jobsByStatus,
    activeJobs,
  };
}

export interface ReportAnalytics {
  topCustomers: { customerId: string; name: string; total: number }[];
  revenueByMonth: { monthKey: string; paid: number; outstanding: number }[];
  jobsByStaff: { name: string; completed: number; total: number; rate: number }[];
}

// The last `n` calendar-month keys ("YYYY-MM"), oldest→newest, ending this month.
function lastNMonthKeys(n: number): string[] {
  const now = new Date();
  const keys: string[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    keys.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
  }
  return keys;
}

// Admin-only staff cost & efficiency over the last 12 months. Mirrors the web
// Reports page. staff_cost_profiles / staff_leave are payroll-sensitive (RLS
// admin-only) — the Reports screen only calls this for admins.
export async function getStaffEfficiency(): Promise<StaffEffRow[]> {
  const cutoff = new Date();
  cutoff.setFullYear(cutoff.getFullYear() - 1);
  const cutoffIso = cutoff.toISOString();
  const cutoffDate = cutoffIso.slice(0, 10);

  const [profilesRes, leaveRes, workRes, equipRes, nameRes] = await Promise.all([
    supabase.from("staff_cost_profiles").select("*"),
    supabase.from("staff_leave").select("staff_id, leave_type, hours, start_date").gte("start_date", cutoffDate),
    supabase.from("time_entries").select("staff_id, hours").eq("entry_type", "work").gte("clock_in", cutoffIso).not("hours", "is", null),
    supabase.from("equipment").select("*").eq("is_active", true),
    supabase.from("profiles").select("id, full_name"),
  ]);

  type NameRow = { id: string; full_name: string };
  const nameByStaff: Record<string, string> = {};
  for (const p of (nameRes.data as unknown as NameRow[]) ?? []) nameByStaff[p.id] = p.full_name;

  const input: StaffEffInput = {
    profiles: (profilesRes.data as unknown as StaffEffProfile[]) ?? [],
    workEntries: (workRes.data as unknown as { staff_id: string; hours: number | null }[]) ?? [],
    leaveEntries: (leaveRes.data as unknown as { staff_id: string; leave_type: string; hours: number | null }[]) ?? [],
    equipment: (equipRes.data as unknown as StaffEffInput["equipment"]) ?? [],
    nameByStaff,
  };
  return computeStaffEfficiency(input);
}

// Equipment cost & utilisation over the last 12 months (office/admin — not
// payroll-sensitive). Mirrors the web Reports page.
export async function getEquipmentUtilization(): Promise<EquipUtilRow[]> {
  const cutoff = new Date();
  cutoff.setFullYear(cutoff.getFullYear() - 1);
  const cutoffDate = cutoff.toISOString().slice(0, 10);

  const [equipRes, usageRes] = await Promise.all([
    supabase.from("equipment").select("*").eq("is_active", true),
    supabase.from("equipment_usage_log").select("equipment_id, hours, usage_date").gte("usage_date", cutoffDate),
  ]);
  const input: EquipUtilInput = {
    equipment: (equipRes.data as unknown as EquipUtilInput["equipment"]) ?? [],
    usage: (usageRes.data as unknown as { equipment_id: string; hours: number | null }[]) ?? [],
  };
  return computeEquipmentUtilization(input);
}

export async function getReportAnalytics(): Promise<ReportAnalytics> {
  const [invRes, jobsRes] = await Promise.all([
    supabase.from("invoices").select("customer_id, total, status, created_at, customers(name)"),
    supabase.from("jobs").select("status, assigned_profile:profiles!jobs_assigned_to_fkey(full_name)"),
  ]);

  type InvRaw = { customer_id: string; total: number | null; status: string; created_at: string; customers: { name: string } | null };
  const invoices: InvoiceRow[] = ((invRes.data as unknown as InvRaw[]) ?? []).map((r) => ({
    customer_id: r.customer_id,
    customer_name: r.customers?.name ?? null,
    total: r.total,
    status: r.status,
    created_at: r.created_at,
  }));

  type JobRaw = { status: string; assigned_profile: { full_name: string } | null };
  const jobs: JobStaffRow[] = ((jobsRes.data as unknown as JobRaw[]) ?? []).map((r) => ({
    assignee_name: r.assigned_profile?.full_name ?? null,
    status: r.status,
  }));

  return {
    topCustomers: topCustomersBySpend(invoices, 8),
    revenueByMonth: revenueByMonth(invoices, lastNMonthKeys(6)),
    jobsByStaff: jobsByStaff(jobs),
  };
}
