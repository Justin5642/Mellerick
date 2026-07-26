// Pure aggregation helpers for the Reports analytics tables — kept out of the
// reads layer so they're testable without a supabase mock. Mirror the web
// Reports page definitions.

export interface InvoiceRow { customer_id: string; customer_name: string | null; total: number | null; status: string; created_at: string }
export interface JobStaffRow { assignee_name: string | null; status: string }

// Top customers by spend: sum of non-cancelled invoice totals per customer,
// highest first, capped at `limit`.
export function topCustomersBySpend(invoices: InvoiceRow[], limit = 8): { customerId: string; name: string; total: number }[] {
  const byCustomer = new Map<string, { name: string; total: number }>();
  for (const inv of invoices) {
    if (inv.status === "cancelled") continue;
    const cur = byCustomer.get(inv.customer_id) ?? { name: inv.customer_name ?? "—", total: 0 };
    cur.total += Number(inv.total ?? 0);
    byCustomer.set(inv.customer_id, cur);
  }
  return [...byCustomer.entries()]
    .map(([customerId, v]) => ({ customerId, name: v.name, total: v.total }))
    .sort((a, b) => b.total - a.total)
    .slice(0, limit);
}

// Revenue bucketed by month: paid (status 'paid') vs outstanding (sent/overdue),
// for the given month keys ("YYYY-MM"). `monthOf` maps an invoice's created_at
// to its month key — the reads layer passes a Melbourne-business-TZ extractor to
// match the web (an invoice near a month boundary must land in the same month on
// both apps); the default (UTC slice) keeps the pure tests deterministic.
export function revenueByMonth(
  invoices: InvoiceRow[],
  monthKeys: string[],
  monthOf: (createdAtIso: string) => string = (iso) => (iso ?? "").slice(0, 7)
): { monthKey: string; paid: number; outstanding: number }[] {
  return monthKeys.map((monthKey) => {
    let paid = 0;
    let outstanding = 0;
    for (const inv of invoices) {
      if (monthOf(inv.created_at ?? "") !== monthKey) continue;
      const amt = Number(inv.total ?? 0);
      if (inv.status === "paid") paid += amt;
      else if (inv.status === "sent" || inv.status === "overdue") outstanding += amt;
    }
    return { monthKey, paid, outstanding };
  });
}

// Jobs by staff member: total assigned + completed + completion rate (%),
// highest total first. UNASSIGNED jobs are excluded (matches the web Reports
// page's `if (!j.assigned_to) return`).
export function jobsByStaff(jobs: JobStaffRow[]): { name: string; completed: number; total: number; rate: number }[] {
  const byStaff = new Map<string, { completed: number; total: number }>();
  for (const j of jobs) {
    if (!j.assignee_name) continue; // no assignee → not counted (web parity)
    const name = j.assignee_name;
    const cur = byStaff.get(name) ?? { completed: 0, total: 0 };
    cur.total += 1;
    if (j.status === "completed") cur.completed += 1;
    byStaff.set(name, cur);
  }
  return [...byStaff.entries()]
    .map(([name, v]) => ({ name, completed: v.completed, total: v.total, rate: v.total ? (v.completed / v.total) * 100 : 0 }))
    .sort((a, b) => b.total - a.total);
}
