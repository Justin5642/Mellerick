import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchAllRows } from "@/lib/fetch-all-rows";

// Which supplier bills in Xero can be traced to a job?
//
// Profit per job has been wrong because a bill reaches Xero by ACCOUNT
// ("Materials"), not by job. Every bill the app itself makes (a PO's invoice,
// an expense) already knows its job. The rest — keyed straight into Xero, a
// statement, fuel — do not, and this finds them (Justin, 14 Nov 2026).
//
// Reads the Xero mirror (draft migration 0098, not applied yet) and the office's
// own decisions (draft migration 0099, not applied yet). Amounts are
// ex-GST (`sub_total`), the figure costs are measured on.

export type BillClass =
  | "crm"         // the app made this bill from a PO invoice or an expense — its job is known
  | "manual"      // the office assigned it to a job in the report
  | "referenced"  // keyed in Xero with a PO-/JOB- number in the reference (not checked against the CRM)
  | "overhead"    // the office marked it a business running cost, deliberately on no job
  | "unallocated";

export interface MirrorBill {
  xero_invoice_id: string;
  invoice_number: string | null;
  reference: string | null;
  contact_name: string | null;
  status: string;
  invoice_date: string | null;
  sub_total: number;
}

export interface ClassifiedBill extends MirrorBill {
  cls: BillClass;
}

/** Bills that are real costs: authorised or paid. Drafts, submitted-for-approval, voided and deleted are not. */
export const COUNTED_STATUSES = ["AUTHORISED", "PAID"];

const REFERENCE = /\b(PO|JOB)[\s#-]?\d+/i;

export function hasJobReference(reference: string | null | undefined): boolean {
  return !!reference && REFERENCE.test(reference);
}

export interface BillContext {
  /** xero_invoice_id of every bill the app made (vendor_orders / job_expenses `xero_bill_id`). */
  crmBillIds: Set<string>;
  /** The office's decisions, by xero_invoice_id. */
  allocations: Map<string, "job" | "overhead">;
}

/**
 * The order matters: what the app KNOWS (it made the bill) beats what the office
 * DECIDED, which beats what a reference merely SUGGESTS.
 */
export function classifyBill(bill: MirrorBill, ctx: BillContext): BillClass {
  if (ctx.crmBillIds.has(bill.xero_invoice_id)) return "crm";
  const decision = ctx.allocations.get(bill.xero_invoice_id);
  if (decision === "overhead") return "overhead";
  if (decision === "job") return "manual";
  if (hasJobReference(bill.reference)) return "referenced";
  return "unallocated";
}

export interface MonthCoverage {
  month: string; // yyyy-mm
  total: number;
  byClass: Record<BillClass, number>;
  /** Share of job-type spend (everything except overheads) traced to a job, 0–100; null when there is none. */
  tracedPct: number | null;
}

const emptyClasses = (): Record<BillClass, number> => ({ crm: 0, manual: 0, referenced: 0, overhead: 0, unallocated: 0 });
const round2 = (n: number) => Math.round(n * 100) / 100;

/** Per-month dollars by class, oldest month first. A bill with no date is left out (it cannot be placed). */
export function coverageByMonth(bills: ClassifiedBill[]): MonthCoverage[] {
  const months = new Map<string, MonthCoverage>();
  for (const b of bills) {
    if (!b.invoice_date) continue;
    const month = b.invoice_date.slice(0, 7);
    const m = months.get(month) ?? { month, total: 0, byClass: emptyClasses(), tracedPct: null };
    m.byClass[b.cls] += b.sub_total;
    m.total += b.sub_total;
    months.set(month, m);
  }
  return [...months.values()]
    .sort((a, b) => a.month.localeCompare(b.month))
    .map((m) => {
      const jobSpend = m.total - m.byClass.overhead;
      const traced = m.byClass.crm + m.byClass.manual + m.byClass.referenced;
      return {
        ...m,
        total: round2(m.total),
        byClass: Object.fromEntries(Object.entries(m.byClass).map(([k, v]) => [k, round2(v)])) as Record<BillClass, number>,
        tracedPct: jobSpend > 0 ? Math.round((traced / jobSpend) * 1000) / 10 : null,
      };
    });
}

export interface UnallocatedSummary {
  count: number;
  total: number;
  /** Oldest first. */
  bills: ClassifiedBill[];
}

export function unallocatedSummary(bills: ClassifiedBill[]): UnallocatedSummary {
  const list = bills
    .filter((b) => b.cls === "unallocated")
    .sort((a, b) => (a.invoice_date ?? "").localeCompare(b.invoice_date ?? ""));
  return { count: list.length, total: round2(list.reduce((s, b) => s + b.sub_total, 0)), bills: list };
}

export type LoadResult =
  | { ok: true; bills: ClassifiedBill[] }
  | { ok: false; error: string; tablesMissing: boolean };

const missing = (message: string) => /does not exist|schema cache|PGRST205|42P01/i.test(message);

/**
 * Reads every supplier bill dated in the last `months` months and classifies it.
 * `client` runs under the caller's RLS (office/admin) or as the service role (the
 * weekly email); either way a failed read is an error, never a smaller list.
 */
export async function loadBills(client: SupabaseClient, months = 12, now = new Date()): Promise<LoadResult> {
  const since = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - months + 1, 1)).toISOString().slice(0, 10);

  const bills = await fetchAllRows<MirrorBill>((count) =>
    client
      .from("xero_invoices")
      .select("xero_invoice_id, invoice_number, reference, contact_name, status, invoice_date, sub_total", count)
      .eq("type", "ACCPAY")
      .in("status", COUNTED_STATUSES)
      .gte("invoice_date", since)
      .order("xero_invoice_id") as never
  );
  if (!bills.ok) return { ok: false, error: bills.error, tablesMissing: missing(bills.error) };

  const linked = async (table: "vendor_orders" | "job_expenses") =>
    fetchAllRows<{ xero_bill_id: string }>((count) =>
      client.from(table).select("xero_bill_id", count).not("xero_bill_id", "is", null).order("xero_bill_id") as never
    );
  const [orders, expenses, allocs] = await Promise.all([
    linked("vendor_orders"),
    linked("job_expenses"),
    fetchAllRows<{ xero_invoice_id: string; kind: "job" | "overhead" }>((count) =>
      client.from("xero_bill_allocations").select("xero_invoice_id, kind", count).order("xero_invoice_id") as never
    ),
  ]);
  for (const r of [orders, expenses, allocs]) {
    if (!r.ok) return { ok: false, error: r.error, tablesMissing: missing(r.error) };
  }
  if (!orders.ok || !expenses.ok || !allocs.ok) return { ok: false, error: "read failed", tablesMissing: false };

  const ctx: BillContext = {
    crmBillIds: new Set([...orders.rows, ...expenses.rows].map((r) => r.xero_bill_id)),
    allocations: new Map(allocs.rows.map((a) => [a.xero_invoice_id, a.kind])),
  };
  return {
    ok: true,
    bills: bills.rows.map((b) => ({ ...b, sub_total: Number(b.sub_total), cls: classifyBill(b, ctx) })),
  };
}
