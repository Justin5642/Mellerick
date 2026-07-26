import { supabase } from "../../supabase";
import { topCustomersBySpend, revenueByMonth, jobsByStaff, type InvoiceRow, type JobStaffRow } from "../../reportsAnalytics";

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
