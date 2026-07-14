export const dynamic = "force-dynamic";

import { createClient } from "@/lib/supabase/server";
import { ReportsDashboard } from "@/components/reports/reports-dashboard";
import { computeLoadedCost } from "@/lib/staff-cost";
import { computeEquipmentCost } from "@/lib/equipment-cost";
import { businessDateParts, formatDate } from "@/lib/date";

function monthKey(date: string) {
  const { year, month } = businessDateParts(date);
  return `${year}-${String(month).padStart(2, "0")}`;
}

function monthLabel(key: string) {
  const [year, month] = key.split("-").map(Number);
  return formatDate(new Date(year, month - 1, 1), { month: "short", year: "2-digit" });
}

export default async function ReportsPage() {
  const supabase = await createClient();

  const [{ data: invoices }, { data: quotes }, { data: jobs }, { data: profiles }, { data: { user } }] = await Promise.all([
    supabase.from("invoices").select("id, total, status, created_at, customer_id, customers(name)"),
    supabase.from("quotes").select("id, total, status, created_at"),
    supabase.from("jobs").select("id, status, assigned_to, created_at"),
    supabase.from("profiles").select("id, full_name").eq("is_active", true),
    supabase.auth.getUser(),
  ]);

  // Staff cost/efficiency data is payroll-sensitive (wage, super, sick
  // leave), so it's only fetched and passed down at all when the viewer is
  // an admin -- everyone else gets `staffEfficiency: null` and the
  // dashboard component simply doesn't render that section.
  let isAdmin = false;
  if (user) {
    const { data: viewerProfile } = await supabase.from("profiles").select("role").eq("id", user.id).single();
    isAdmin = viewerProfile?.role === "admin";
  }

  let staffEfficiency: {
    name: string;
    loadedHourlyRate: number;
    workedHours: number;
    sickHours: number;
    leaveHours: number;
    utilizationPct: number | null;
    trueCostPerWorkedHour: number | null;
  }[] = [];

  if (isAdmin) {
    const twelveMonthsAgo = new Date();
    twelveMonthsAgo.setFullYear(twelveMonthsAgo.getFullYear() - 1);
    const cutoffIso = twelveMonthsAgo.toISOString();
    const cutoffDate = twelveMonthsAgo.toISOString().slice(0, 10);

    const [{ data: costProfiles }, { data: leaveEntries }, { data: workEntries }] = await Promise.all([
      supabase.from("staff_cost_profiles").select("*"),
      supabase.from("staff_leave").select("staff_id, leave_type, hours, start_date").gte("start_date", cutoffDate),
      supabase.from("time_entries").select("staff_id, hours").eq("entry_type", "work").gte("clock_in", cutoffIso).not("hours", "is", null),
    ]);

    const profileNameMap = new Map((profiles ?? []).map((p: any) => [p.id, p.full_name]));

    const workedByStaff = new Map<string, number>();
    (workEntries ?? []).forEach((e: any) => {
      workedByStaff.set(e.staff_id, (workedByStaff.get(e.staff_id) ?? 0) + Number(e.hours ?? 0));
    });

    const sickByStaff = new Map<string, number>();
    const leaveByStaff = new Map<string, number>();
    (leaveEntries ?? []).forEach((l: any) => {
      const hours = Number(l.hours ?? 0);
      leaveByStaff.set(l.staff_id, (leaveByStaff.get(l.staff_id) ?? 0) + hours);
      if (l.leave_type === "sick") {
        sickByStaff.set(l.staff_id, (sickByStaff.get(l.staff_id) ?? 0) + hours);
      }
    });

    staffEfficiency = (costProfiles ?? [])
      .map((cp: any) => {
        const { annualLoadedCost, loadedHourlyRate } = computeLoadedCost(cp);
        const workedHours = workedByStaff.get(cp.staff_id) ?? 0;
        const leaveHours = leaveByStaff.get(cp.staff_id) ?? 0;
        const sickHours = sickByStaff.get(cp.staff_id) ?? 0;
        const paidHours = workedHours + leaveHours;
        return {
          name: profileNameMap.get(cp.staff_id) ?? "Unknown",
          loadedHourlyRate,
          workedHours,
          sickHours,
          leaveHours,
          utilizationPct: paidHours > 0 ? (workedHours / paidHours) * 100 : null,
          trueCostPerWorkedHour: workedHours > 0 ? annualLoadedCost / workedHours : null,
        };
      })
      .sort((a, b) => (b.trueCostPerWorkedHour ?? 0) - (a.trueCostPerWorkedHour ?? 0));
  }

  // Equipment cost/utilization -- not payroll-sensitive (equipment table is
  // readable by any authenticated user, same as the Fleet page), so this
  // runs for everyone, not just admins. Same "true cost per hour actually
  // used" idea as staff efficiency above: fixed costs (depreciation,
  // insurance, maintenance, rego) are incurred whether or not the item gets
  // used, so low utilization drives the true $/hr well above the budgeted
  // rate -- the signal for "hire it instead of owning it."
  const equipmentTwelveMonthsAgo = new Date();
  equipmentTwelveMonthsAgo.setFullYear(equipmentTwelveMonthsAgo.getFullYear() - 1);
  const equipmentCutoffDate = equipmentTwelveMonthsAgo.toISOString().slice(0, 10);

  const [{ data: equipmentList }, { data: equipmentUsage }] = await Promise.all([
    supabase.from("equipment").select("*").eq("is_active", true),
    supabase.from("equipment_usage_log").select("equipment_id, hours, usage_date").gte("usage_date", equipmentCutoffDate),
  ]);

  const hoursByEquipment = new Map<string, number>();
  (equipmentUsage ?? []).forEach((u: any) => {
    hoursByEquipment.set(u.equipment_id, (hoursByEquipment.get(u.equipment_id) ?? 0) + Number(u.hours ?? 0));
  });

  const equipmentUtilization = (equipmentList ?? [])
    .map((eq: any) => {
      const { costPerHour, annualFixedCost, annualTotalCost } = computeEquipmentCost(eq);
      const hoursUsed = hoursByEquipment.get(eq.id) ?? 0;
      const targetHours = Number(eq.target_hours_per_year ?? 0);
      return {
        name: eq.name,
        hoursUsed,
        budgetedCostPerHour: costPerHour,
        annualTotalCost,
        utilizationPct: targetHours > 0 ? (hoursUsed / targetHours) * 100 : null,
        trueCostPerHourUsed: hoursUsed > 0 ? annualFixedCost / hoursUsed + Number(eq.fuel_cost_per_hour ?? 0) : null,
      };
    })
    .sort((a, b) => (b.trueCostPerHourUsed ?? 0) - (a.trueCostPerHourUsed ?? 0));

  const invoicesData = invoices ?? [];
  const quotesData = quotes ?? [];
  const jobsData = jobs ?? [];
  const profilesData = profiles ?? [];

  // ---- Revenue by month (last 6 months), paid vs outstanding ----
  const { year: nowYear, month: nowMonth } = businessDateParts();
  const monthKeys: string[] = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date(nowYear, nowMonth - 1 - i, 1);
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
      staffEfficiency={isAdmin ? staffEfficiency : null}
      equipmentUtilization={equipmentUtilization}
    />
  );
}
