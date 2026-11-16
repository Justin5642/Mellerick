import { BUSINESS_TIME_ZONE } from "@/lib/date";

// Payment terms on an invoice (Justin, 16 Nov 2026: "add 14, 30 day invoice
// dropbox"). A term just fills in the due date from the invoice date, in
// Melbourne days; the due date stays the only thing stored, so a date typed
// by hand still wins and shows as "Custom date".

export const INVOICE_TERM_DAYS = [14, 30] as const;
export type InvoiceTerm = (typeof INVOICE_TERM_DAYS)[number] | "custom";

const ymd = new Intl.DateTimeFormat("en-CA", {
  timeZone: BUSINESS_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** The Melbourne calendar date of an instant, as YYYY-MM-DD. */
export function melbourneDay(at: Date): string {
  return ymd.format(at);
}

/** YYYY-MM-DD plus `days` calendar days. */
export function addDays(day: string, days: number): string {
  const [y, m, d] = day.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return t.toISOString().slice(0, 10);
}

/** The due date for a term, counted from the invoice date (a Melbourne day). */
export function dueDateForTerm(days: number, invoiceDay: string): string {
  return addDays(invoiceDay, days);
}

/** Which term a due date matches, counted from the invoice date; "custom" otherwise. */
export function termForDueDate(dueDate: string, invoiceDay: string): InvoiceTerm {
  if (!dueDate) return "custom";
  const hit = INVOICE_TERM_DAYS.find((n) => dueDateForTerm(n, invoiceDay) === dueDate);
  return hit ?? "custom";
}
