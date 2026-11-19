// What a customer still owes, and how late it is.
//
// An invoice's balance is its total less amount_paid. amount_paid is kept
// current two ways (migration 0081): by recorded
// payments for invoices that are not in Xero, and by the Xero poll
// (lib/xero.ts) for those that are. Everything here reads that one column, so
// the two sources never need adding together.

export const PAYMENT_METHODS = [
  { value: "bank_transfer", label: "Bank transfer" },
  { value: "cash", label: "Cash" },
  { value: "card", label: "Card" },
  { value: "cheque", label: "Cheque" },
  { value: "other", label: "Other" },
] as const;

export type PaymentMethod = (typeof PAYMENT_METHODS)[number]["value"];

export function paymentMethodLabel(method: string): string {
  return PAYMENT_METHODS.find((m) => m.value === method)?.label ?? method;
}

export interface OwedInvoice {
  id: string;
  invoice_number: number;
  title: string;
  total: number | string | null;
  amount_paid: number | string | null;
  due_date: string | null;
  status: string;
  customers?: { name: string | null } | null;
}

/** Money still owed on an invoice, never below zero, to the cent. */
export function balanceOf(inv: Pick<OwedInvoice, "total" | "amount_paid">): number {
  const owed = Number(inv.total ?? 0) - Number(inv.amount_paid ?? 0);
  return Math.max(0, Math.round(owed * 100) / 100);
}

/** Statuses that are money we are waiting on. Drafts have not been sent. */
export const OWED_STATUSES = ["sent", "overdue"];

export type AgeBucket = "current" | "1-30" | "31-60" | "61-90" | "90+";

export const AGE_BUCKETS: { key: AgeBucket; label: string }[] = [
  { key: "current", label: "Not yet due" },
  { key: "1-30", label: "1–30 days overdue" },
  { key: "31-60", label: "31–60 days overdue" },
  { key: "61-90", label: "61–90 days overdue" },
  { key: "90+", label: "90+ days overdue" },
];

/** Days past the due date ("YYYY-MM-DD" keys; 0 or less = not yet due). */
export function daysOverdue(dueDate: string | null, todayKey: string): number {
  if (!dueDate) return 0;
  const ms = Date.parse(`${todayKey}T00:00:00Z`) - Date.parse(`${dueDate.slice(0, 10)}T00:00:00Z`);
  return Math.round(ms / 86_400_000);
}

export function ageBucket(dueDate: string | null, todayKey: string): AgeBucket {
  const d = daysOverdue(dueDate, todayKey);
  if (d <= 0) return "current";
  if (d <= 30) return "1-30";
  if (d <= 60) return "31-60";
  if (d <= 90) return "61-90";
  return "90+";
}

export interface OwedSummary {
  outstanding: number;
  overdue: number;
  count: number;
  buckets: { key: AgeBucket; label: string; total: number; invoices: (OwedInvoice & { balance: number; daysOverdue: number })[] }[];
}

/** Outstanding and overdue totals, grouped by how late, most overdue first within each group. */
export function summarizeOwed(invoices: OwedInvoice[], todayKey: string): OwedSummary {
  const buckets = AGE_BUCKETS.map((b) => ({ ...b, total: 0, invoices: [] as OwedSummary["buckets"][number]["invoices"] }));
  let outstanding = 0;
  let overdue = 0;
  let count = 0;
  for (const inv of invoices) {
    if (!OWED_STATUSES.includes(inv.status)) continue;
    const balance = balanceOf(inv);
    if (balance <= 0) continue;
    const late = daysOverdue(inv.due_date, todayKey);
    const bucket = buckets.find((b) => b.key === ageBucket(inv.due_date, todayKey))!;
    bucket.invoices.push({ ...inv, balance, daysOverdue: Math.max(0, late) });
    bucket.total = Math.round((bucket.total + balance) * 100) / 100;
    outstanding += balance;
    if (late > 0) overdue += balance;
    count++;
  }
  for (const b of buckets) b.invoices.sort((a, c) => c.daysOverdue - a.daysOverdue || c.balance - a.balance);
  return {
    outstanding: Math.round(outstanding * 100) / 100,
    overdue: Math.round(overdue * 100) / 100,
    count,
    buckets,
  };
}

// ---------------------------------------------------------------------------
// Recording a payment (web Payments card and the phone, both through
// POST /api/invoices/[id]/payments). The database re-checks all of it (0081).
// ---------------------------------------------------------------------------

export interface PaymentInput {
  amount: number;
  paid_on: string;
  method: PaymentMethod;
  reference: string | null;
}

/** The longest reference kept — a bank reference, not a note. */
export const PAYMENT_REFERENCE_MAX = 200;

const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;

/** A payment from a request body or a form, or the sentence saying why not. */
export function parsePayment(
  body: unknown
): { ok: true; payment: PaymentInput } | { ok: false; error: string } {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const raw = typeof b.amount === "string" ? b.amount.trim() : b.amount;
  const value = raw == null || raw === "" ? NaN : Number(raw);
  const amount = Math.round(value * 100) / 100;
  if (!Number.isFinite(value) || !(amount > 0) || amount >= 100_000_000) {
    return { ok: false, error: "Enter the amount received." };
  }
  const paidOn = typeof b.paid_on === "string" ? b.paid_on.trim() : "";
  if (!DATE_KEY.test(paidOn) || Number.isNaN(Date.parse(`${paidOn}T00:00:00Z`))) {
    return { ok: false, error: "Enter the date the payment was received." };
  }
  const method = typeof b.method === "string" && b.method ? b.method : "bank_transfer";
  if (!PAYMENT_METHODS.some((m) => m.value === method)) return { ok: false, error: "Choose how the payment was made." };
  const reference = typeof b.reference === "string" ? b.reference.trim().slice(0, PAYMENT_REFERENCE_MAX) : "";
  return { ok: true, payment: { amount, paid_on: paidOn, method: method as PaymentMethod, reference: reference || null } };
}

const dollars = (n: number) => `$${n.toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** What the office is told once a payment is saved. */
export function paymentRecordedMessage(amount: number, balanceBefore: number): string {
  if (amount >= balanceBefore) return "Payment recorded — invoice paid";
  return `Payment recorded — ${dollars(Math.max(0, Math.round((balanceBefore - amount) * 100) / 100))} still owing`;
}

/** The Payments card's headline: a draft has not been sent; otherwise what is owed, or paid. */
export function paymentStatusLabel(status: string, balance: number): string {
  if (status === "draft") return "Not sent yet";
  return balance > 0 ? `${dollars(balance)} owing` : "Paid in full";
}

/** Whether "Record payment" is offered: sent, money still owed, and not in Xero (Xero is the record there). */
export function canRecordPayment(inv: {
  status: string;
  xero_invoice_id: string | null;
  total: number | string | null;
  amount_paid: number | string | null;
}): boolean {
  return inv.status !== "draft" && !inv.xero_invoice_id && balanceOf(inv) > 0;
}

/** The 0081 trigger's refusal for an invoice in Xero, said the same way everywhere. */
export const PAYMENT_IN_XERO = "This invoice is in Xero — record the payment in Xero; the app picks it up from there.";
