export const dynamic = "force-dynamic";

import { createClient } from "@/lib/supabase/server";
import { ReportsDashboard } from "@/components/reports/reports-dashboard";

function monthKey(date: string) {
  const d = new Date(date);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function monthLabel(key: string) {
  const [year, month] = key.split("-").map(Number);
  return new Date(year, month - 1, 1).toLocaleDateString("en-AU", { month: "short", year: "2-digit" });
}

export default async function ReportsPage() {
  const supabase = await createClient();

  const [{ data: invoices }, { data: quotes }, { data: jobs }, { data: profiles }] = await Promise.all([
    supabase.from("invoices").select("id, total, status, created_at, customer_id, customers(name)"),
    supabase.from("quotes").select("id, total, status, created_at"),
    supabase.from("jobs").select("id, status, assigned_to, created_at"),
    supabase.from("profiles").select("id, full_name").eq("is_active", true),
  ]);

  const invoicesData = invoices ?? [];
  const quotesData = quotes ?? [];
  const jobsData = jobs ?? [];
  const profilesData = profiles ?? [];

  // ---- Revenue by month (last 6 months), paid vs outstanding ----
  const now = new Date();
  const monthKeys: string[] = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    monthKeys.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
  }
  const revenueByMonth = monthKeys.map((key) => {
    const monthInvoices = invoicesData.filter((inv: any) => monthKey(inv.created_at) === key);
    const paid = monthInvoices.filter((inv: any) => inv.status === "paid").reduce((s: number, i: any) => s + Number(i.total), 0);
    const outstanding = monthInvoices
      .filter((inv: any) => inv.status === "sent" || inv.status === "overdue")
      .reduce((s: number, i: any) => s + Number(i.total), 0);
    return { month: monthLabel(key), paid, outstanding };
  });

  const totalRevenuePaid = invoicesData.filter((i: any) => i.status === "paid").reduce((s: number, i: any) => s + Number(i.total), 0);
  const totalOutstanding = invoicesData
    .filter((i: any) => i.status === "sent" || i.status === "overdue")
    .reduce((s: number, i: any) => s + Number(i.total), 0);
  const totalOverdue = invoicesData.filter((i: any) => i.status === "overdue").reduce((s: number, i: any) => s + Number(i.total), 0);

  // ---- Quote conversion ----
  const quoteStatusCounts: Record<string, number> = { draft: 0, sent: 0, accepted: 0, declined: 0, expired: 0 };
  quotesData.forEach((q: any) => {
    quoteStatusCounts[q.status] = (quoteStatusCounts[q.status] ?? 0) + 1;
  });
  const respondedQuotes = quoteStatusCounts.accepted + quoteStatusCounts.declined;
  const winRate = respondedQuotes > 0 ? (quoteStatusCounts.accepted / respondedQuotes) * 100 : 0;
  const acceptedValue = quotesData.filter((q: any) => q.status === "accepted").reduce((s: number, q: any) => s + Number(q.total), 0);

  // ---- Job stats ----
  const jobStatusCounts: Record<string, number> = {
    pending: 0, scheduled: 0, in_progress: 0, completed: 0, cancelled: 0, on_hold: 0,
  };
  jobsData.forEach((j: any) => {
    jobStatusCounts[j.status] = (jobStatusCounts[j.status] ?? 0) + 1;
  });

  const profileMap = new Map(profilesData.map((p: any) => [p.id, p.full_name]));
  const staffJobCounts = new Map<string, { name: string; total: number; completed: number }>();
  jobsData.forEach((j: any) => {
    if (!j.assigned_to) return;
    const name = profileMap.get(j.assigned_to) ?? "Unknown";
    const entry = staffJobCounts.get(j.assigned_to) ?? { name, total: 0, completed: 0 };
    entry.total += 1;
    if (j.status === "completed") entry.completed += 1;
    staffJobCounts.set(j.assigned_to, entry);
  });
  const jobsByStaff = Array.from(staffJobCounts.values()).sort((a, b) => b.total - a.total);

  // ---- Top customers by spend ----
  const customerSpend = new Map<string, { name: string; total: number }>();
  invoicesData.forEach((inv: any) => {
    if (inv.status === "cancelled") return;
    const name = inv.customers?.name ?? "Unknown";
    const entry = customerSpend.get(inv.customer_id) ?? { name, total: 0 };
    entry.total += Number(inv.total);
    customerSpend.set(inv.customer_id, entry);
  });
  const topCustomers = Array.from(customerSpend.values())
    .sort((a, b) => b.total - a.total)
    .slice(0, 8);

  return (
    <ReportsDashboard
      revenueByMonth={revenueByMonth}
      totalRevenuePaid={totalRevenuePaid}
      totalOutstanding={totalOutstanding}
      totalOverdue={totalOverdue}
      quoteStatusCounts={quoteStatusCounts}
      winRate={winRate}
      acceptedValue={acceptedValue}
      jobStatusCounts={jobStatusCounts}
      jobsByStaff={jobsByStaff}
      topCustomers={topCustomers}
      totalJobs={jobsData.length}
      totalQuotes={quotesData.length}
    />
  );
}
