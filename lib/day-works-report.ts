// Reports → Day Works (Day Works next stages, item 5, first half; Nov 2026).
// Pure, so the page stays a thin loader and the sums are tested.
//
// Day Works / hire revenue by company cost centre per month, plus a per-job
// breakdown for one month. Every entry is priced with lib/hire-pricing.ts
// (priceEntry: machine + each attachment at a full day) at the rates CURRENT
// when the report is shown — hire_entries hold quantities only and never
// snapshot a rate, so a rate change re-prices past months here.
//
// Counted: signed and invoiced entries (each kept apart, so the page can show
// either or both). Drafts are not revenue yet: they are counted (and priced)
// separately as "not yet signed". Void entries are ignored.
//
// Office/admin only — it reads the rate tables.

import { DEFAULT_COST_CENTRE_BY_TYPE, priceEntry, type HireAttachmentRate, type HireEntryQuantities, type HireOption } from "@/lib/hire-pricing";

export interface ReportEntry extends HireEntryQuantities {
  job_id: string;
  attachment_ids: string[];
}

export interface ReportCostCentre {
  id: string;
  name: string;
}

/** Which revenue the page is showing. */
export type ReportView = "all" | "signed" | "invoiced";

export interface ReportCell {
  /** Signed, not yet invoiced (ex GST). */
  signed: number;
  invoiced: number;
  /** Signed + invoiced entries counted. */
  entries: number;
  /** Signed/invoiced entries whose machine has no hire setup — not in the amounts. */
  unpriced: number;
  /** Drafts — not yet signed, so not revenue. */
  drafts: number;
  draftAmount: number;
}

export const UNTAGGED = "untagged";
export const UNTAGGED_NAME = "Not tagged";

const cents = (n: number) => Math.round(n * 100) / 100;

export const emptyCell = (): ReportCell => ({ signed: 0, invoiced: 0, entries: 0, unpriced: 0, drafts: 0, draftAmount: 0 });

export function cellAmount(c: ReportCell, view: ReportView): number {
  if (view === "signed") return c.signed;
  if (view === "invoiced") return c.invoiced;
  return cents(c.signed + c.invoiced);
}

export function parseReportView(v: string | undefined | null): ReportView {
  return v === "signed" || v === "invoiced" ? v : "all";
}

/** "2026-11" — the calendar month of a date key. work_date is a plain date (already a Melbourne day). */
export function monthOf(workDate: string): string {
  return workDate.slice(0, 7);
}

/** The `count` months ending at `current` ("YYYY-MM"), newest first. */
export function lastMonths(current: string, count = 12): string[] {
  const [y, m] = current.split("-").map(Number);
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const d = new Date(Date.UTC(y, m - 1 - i, 1));
    out.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`);
  }
  return out;
}

export function isMonthKey(v: string | undefined | null): v is string {
  return !!v && /^\d{4}-(0[1-9]|1[0-2])$/.test(v);
}

/** "Nov 2026". */
export function monthLabel(key: string): string {
  const [y, m] = key.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString("en-AU", { month: "short", year: "numeric", timeZone: "UTC" });
}

interface PricedReportEntry {
  job_id: string;
  month: string;
  status: string;
  centre: string;
  amount: number | null;
}

/**
 * Each entry's cost centre: the one stamped on the entry (0108 sets it at
 * insert), else its hire setup's, else the company default for the hire type
 * by name — the same order as hire_entry_cost_centre() — else "Not tagged".
 */
function priceAll(entries: ReportEntry[], options: HireOption[], attachments: HireAttachmentRate[], centres: ReportCostCentre[]): PricedReportEntry[] {
  const known = new Set(centres.map((c) => c.id));
  const byName = new Map(centres.map((c) => [c.name.trim().toLowerCase(), c.id]));
  const out: PricedReportEntry[] = [];
  for (const e of entries) {
    if (e.status !== "signed" && e.status !== "invoiced" && e.status !== "draft") continue;
    const p = priceEntry(e, options, e.attachment_ids, attachments);
    let centre = p.cost_centre_id ?? byName.get(DEFAULT_COST_CENTRE_BY_TYPE[e.hire_type]?.toLowerCase()) ?? null;
    if (centre && !known.has(centre)) centre = null;
    out.push({ job_id: e.job_id, month: monthOf(e.work_date), status: e.status, centre: centre ?? UNTAGGED, amount: p.total });
  }
  return out;
}

function add(cell: ReportCell, p: PricedReportEntry) {
  if (p.status === "draft") {
    cell.drafts += 1;
    if (p.amount !== null) cell.draftAmount = cents(cell.draftAmount + p.amount);
    return;
  }
  cell.entries += 1;
  if (p.amount === null) cell.unpriced += 1;
  else if (p.status === "signed") cell.signed = cents(cell.signed + p.amount);
  else cell.invoiced = cents(cell.invoiced + p.amount);
}

function bump(map: Record<string, ReportCell>, key: string, p: PricedReportEntry) {
  add((map[key] ??= emptyCell()), p);
}

/** Cost centre columns: the company list in its order, then "Not tagged" when used. Only centres with any entry. */
function columns(used: Set<string>, centres: ReportCostCentre[]): ReportCostCentre[] {
  const cols = centres.filter((c) => used.has(c.id));
  if (used.has(UNTAGGED)) cols.push({ id: UNTAGGED, name: UNTAGGED_NAME });
  return cols;
}

export interface DayWorksMonthly {
  /** Newest first. */
  months: string[];
  centres: ReportCostCentre[];
  /** cells[month][centreId] */
  cells: Record<string, Record<string, ReportCell>>;
  monthTotals: Record<string, ReportCell>;
  centreTotals: Record<string, ReportCell>;
  total: ReportCell;
}

/**
 * Revenue by month × cost centre over `months`. Entries outside those months
 * are left out. `centres` is the company list in display order.
 */
export function dayWorksByMonth(input: {
  entries: ReportEntry[];
  options: HireOption[];
  attachments: HireAttachmentRate[];
  centres: ReportCostCentre[];
  months: string[];
}): DayWorksMonthly {
  const inWindow = new Set(input.months);
  const cells: Record<string, Record<string, ReportCell>> = {};
  const monthTotals: Record<string, ReportCell> = {};
  const centreTotals: Record<string, ReportCell> = {};
  const total = emptyCell();
  const used = new Set<string>();
  for (const p of priceAll(input.entries, input.options, input.attachments, input.centres)) {
    if (!inWindow.has(p.month)) continue;
    used.add(p.centre);
    bump((cells[p.month] ??= {}), p.centre, p);
    bump(monthTotals, p.month, p);
    bump(centreTotals, p.centre, p);
    add(total, p);
  }
  return { months: [...input.months], centres: columns(used, input.centres), cells, monthTotals, centreTotals, total };
}

export interface DayWorksJobRow {
  job_id: string;
  byCentre: Record<string, ReportCell>;
  total: ReportCell;
}

/** One month, job by job — largest (signed + invoiced) first, then drafts-only jobs. */
export function dayWorksJobsForMonth(input: {
  entries: ReportEntry[];
  options: HireOption[];
  attachments: HireAttachmentRate[];
  centres: ReportCostCentre[];
  month: string;
}): { centres: ReportCostCentre[]; jobs: DayWorksJobRow[] } {
  const rows = new Map<string, DayWorksJobRow>();
  const used = new Set<string>();
  for (const p of priceAll(input.entries, input.options, input.attachments, input.centres)) {
    if (p.month !== input.month) continue;
    used.add(p.centre);
    const r = rows.get(p.job_id) ?? { job_id: p.job_id, byCentre: {}, total: emptyCell() };
    bump(r.byCentre, p.centre, p);
    add(r.total, p);
    rows.set(p.job_id, r);
  }
  const jobs = [...rows.values()].sort(
    (a, b) => cellAmount(b.total, "all") - cellAmount(a.total, "all") || b.total.draftAmount - a.total.draftAmount || a.job_id.localeCompare(b.job_id)
  );
  return { centres: columns(used, input.centres), jobs };
}
