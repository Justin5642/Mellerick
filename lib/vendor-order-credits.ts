// Supplier credit notes against a supplier PO (0125, a draft until applied).
//
// vendor_orders holds ONE invoice; each credit note is its own row in
// vendor_order_credits under that order, so the invoice is never overwritten
// and the credit is never lost in it. The job ledger nets an order's credits
// off that order's cost (lib/job-ledger.ts), and the PO tab lists them under
// the order. Office/admin only (RLS); not sent to Xero by the app — the
// office enters the credit note in Xero.
//
// Before 0125 is applied the table is missing (42P01 / PGRST205): every
// reader answers "credits not switched on" with no credits, and nothing else
// changes.

import type { SupabaseClient } from "@supabase/supabase-js";

export interface VendorOrderCredit {
  id: string;
  vendor_order_id: string;
  gmail_invoice_id: string | null;
  credit_number: string | null;
  credit_date: string | null;
  amount_ex_gst: number;
  gst_amount: number;
  file_path: string | null;
  created_at: string;
}

export const CREDIT_COLUMNS = "id, vendor_order_id, gmail_invoice_id, credit_number, credit_date, amount_ex_gst, gst_amount, file_path, created_at";

const MISSING = new Set(["42P01", "PGRST205"]);

export function isCreditsTableMissing(error: { code?: string | null } | null | undefined): boolean {
  return !!error && MISSING.has(error.code ?? "");
}

export const CREDIT_SENTENCES = {
  notSwitchedOn: "Supplier credit notes aren't switched on yet (migration 0125).",
  noInvoice: (po: string) => `${po} has no invoice yet for a credit to come off.`,
  cancelled: (po: string) => `${po} was cancelled.`,
  tooLarge: (po: string, left: number) =>
    `The credit is more than what's left of ${po}'s invoice ($${left.toFixed(2)} ex GST after earlier credits).`,
  duplicate: (po: string) => `That credit note is already on ${po}.`,
} as const;

/** The order's credits, summed ex GST, by order id. */
export function creditTotals(credits: Pick<VendorOrderCredit, "vendor_order_id" | "amount_ex_gst">[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const c of credits) out.set(c.vendor_order_id, Math.round(((out.get(c.vendor_order_id) ?? 0) + (Number(c.amount_ex_gst) || 0)) * 100) / 100);
  return out;
}

/** Orders with their credits (ex GST) attached as `credits`, for the ledger. */
export function withCredits<T extends { id?: string }>(orders: T[], totals: Map<string, number>): (T & { credits: number })[] {
  return orders.map((o) => ({ ...o, credits: (o.id && totals.get(o.id)) || 0 }));
}

/**
 * Why this credit can't go on this order, or null. The database's guard
 * (0125) says the same; this answers first with a sentence for the office.
 */
export function creditRefusal(
  order: { po_number: string; status: string; invoice_number: string | null; amount: number | string | null },
  existing: Pick<VendorOrderCredit, "amount_ex_gst" | "credit_number">[],
  credit: { amount_ex_gst: number; credit_number: string | null },
): string | null {
  if (order.status === "cancelled") return CREDIT_SENTENCES.cancelled(order.po_number);
  if (!order.invoice_number) return CREDIT_SENTENCES.noInvoice(order.po_number);
  const num = (credit.credit_number ?? "").trim().toLowerCase();
  if (num && existing.some((c) => (c.credit_number ?? "").trim().toLowerCase() === num)) return CREDIT_SENTENCES.duplicate(order.po_number);
  const cents = (n: number | string | null) => Math.round((Number(n) || 0) * 100);
  const used = existing.reduce((s, c) => s + cents(c.amount_ex_gst), 0);
  const left = cents(order.amount) - used;
  if (cents(credit.amount_ex_gst) > left) return CREDIT_SENTENCES.tooLarge(order.po_number, Math.max(0, left) / 100);
  return null;
}

/**
 * The credits on these orders, as the caller (RLS). `ready: false` before
 * 0125; `error` on any other failure (the caller shows no credits).
 */
export async function loadOrderCredits(
  db: SupabaseClient,
  orderIds: string[],
): Promise<{ ready: boolean; credits: VendorOrderCredit[]; error: unknown }> {
  if (orderIds.length === 0) return { ready: true, credits: [], error: null };
  const credits: VendorOrderCredit[] = [];
  for (let i = 0; i < orderIds.length; i += 100) {
    const r = await db.from("vendor_order_credits").select(CREDIT_COLUMNS).in("vendor_order_id", orderIds.slice(i, i + 100)).order("created_at");
    if (r.error) {
      if (isCreditsTableMissing(r.error)) return { ready: false, credits: [], error: null };
      return { ready: true, credits: [], error: r.error };
    }
    credits.push(...((r.data ?? []) as VendorOrderCredit[]));
  }
  return { ready: true, credits, error: null };
}
