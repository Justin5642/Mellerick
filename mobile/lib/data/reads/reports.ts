import { supabase } from "../../supabase";

export interface ReportSummary {
  revenuePaid: number;
  outstanding: number;
  quotesAccepted: number;
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
    quotesTotal: quotes.length,
    jobsByStatus,
    activeJobs,
  };
}
