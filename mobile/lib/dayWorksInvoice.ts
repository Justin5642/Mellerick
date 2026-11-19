import { shiftDateKey } from "./date";
import type { DayWorksEntry, DayWorksOfficePricing } from "./dayWorks";
import type { TruckLoad, TruckLoadsOfficePricing } from "./truckLoads";

// "Invoice Day Works" on the phone (office/admin only), the same choices as
// the web tab (components/job/job-day-works.tsx InvoiceDayWorks): a period
// (last week Mon–Sun by default, last month, or everything waiting), the
// signed un-invoiced Day Works lines and signed EXTRA truck loads in it, each
// tickable. The server (POST /api/jobs/[id]/hire-entries/invoice) prices and
// checks everything again; the amounts here come only from the office's own
// pricing answer and are shown only through MoneyText inside a RoleGate.
// No pricing is computed on the phone.

export interface InvoicePeriod {
  from: string;
  to: string;
}

/** Monday of the week containing `key`. */
function mondayOf(key: string): string {
  const [y, m, d] = key.split("-").map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d, 12)).getUTCDay();
  return shiftDateKey(key, dow === 0 ? -6 : 1 - dow);
}

export function lastWeek(today: string): InvoicePeriod {
  const from = shiftDateKey(mondayOf(today), -7);
  return { from, to: shiftDateKey(from, 6) };
}

export function lastMonth(today: string): InvoicePeriod {
  const [y, m] = today.split("-").map(Number);
  const pm = m === 1 ? 12 : m - 1;
  const py = m === 1 ? y - 1 : y;
  return { from: `${py}-${String(pm).padStart(2, "0")}-01`, to: shiftDateKey(`${y}-${String(m).padStart(2, "0")}-01`, -1) };
}

export interface InvoiceLine {
  kind: "entry" | "load";
  id: string;
  date: string;
  /** "PC88 · 6 h" / "Isuzu tipper · Spoil · 12 t …" — quantities only. */
  label: string;
  /** From the office's pricing answer; null = can't be priced (no rate / no docket cost). */
  amount: number | null;
}

export interface InvoiceChoice {
  /** Everything signed and not yet invoiced, any date. */
  waitingCount: number;
  /** First and last date waiting, for "All waiting". */
  allWaiting: InvoicePeriod | null;
  /** Lines in the period, by date. */
  lines: InvoiceLine[];
  /** Ticked lines in the period. */
  picked: InvoiceLine[];
  unpriced: number;
  total: number;
}

export function invoiceChoice(input: {
  entries: DayWorksEntry[];
  entryPricing: DayWorksOfficePricing | undefined;
  loads: TruckLoad[];
  loadPricing: TruckLoadsOfficePricing | undefined;
  period: InvoicePeriod;
  excluded: ReadonlySet<string>;
  entryLabel: (e: DayWorksEntry) => string;
  loadLabel: (l: TruckLoad) => string;
}): InvoiceChoice {
  const { period, excluded } = input;
  const waitingEntries = input.entries.filter((e) => e.status === "signed" && !e.invoice_id);
  const waitingLoads = input.loads.filter((l) => l.status === "signed" && l.billing === "extra" && !l.invoice_id);
  const dates = [...waitingEntries.map((e) => e.work_date), ...waitingLoads.map((l) => l.load_date)].sort();
  const inside = (d: string) => d >= period.from && d <= period.to;
  const lines: InvoiceLine[] = [
    ...waitingEntries
      .filter((e) => inside(e.work_date))
      .map((e) => ({ kind: "entry" as const, id: e.id, date: e.work_date, label: input.entryLabel(e), amount: input.entryPricing?.entries[e.id]?.total ?? null })),
    ...waitingLoads
      .filter((l) => inside(l.load_date))
      .map((l) => ({ kind: "load" as const, id: l.id, date: l.load_date, label: input.loadLabel(l), amount: input.loadPricing?.loads[l.id]?.total ?? null })),
  ].sort((a, b) => a.date.localeCompare(b.date) || (a.kind === b.kind ? 0 : a.kind === "entry" ? -1 : 1));
  const picked = lines.filter((l) => !excluded.has(l.id));
  return {
    waitingCount: waitingEntries.length + waitingLoads.length,
    allWaiting: dates.length > 0 ? { from: dates[0], to: dates[dates.length - 1] } : null,
    lines,
    picked,
    unpriced: picked.filter((l) => l.amount === null).length,
    total: Math.round(picked.reduce((s, l) => s + (l.amount ?? 0), 0) * 100) / 100,
  };
}

/** Why "Create invoice" can't go yet, or null. */
export function invoiceProblem(c: InvoiceChoice): string | null {
  if (c.picked.length === 0) return "Tick at least one line.";
  if (c.unpriced > 0) return `${c.unpriced} ticked line${c.unpriced === 1 ? "" : "s"} can't be priced yet — set the hire rate in Fleet, or enter the load's docket cost.`;
  return null;
}
