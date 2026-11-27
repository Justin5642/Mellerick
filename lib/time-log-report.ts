// Reports → Time log (office feedback, 27 Nov 2026: "have what time log was
// for what job type (e.g. Brodie – Sewer), date, hours on site. Need all
// details."). Pure shaping, totals and CSV for app/dashboard/reports/time-log.
//
// HOURS ONLY. Nothing here reads, carries or prints a rate, an amount or any
// other dollar figure — the page reads time_entries through its column-level
// grants (never rate_override) and po_cost_centers by id and name only.
// tests/unit/time-log-report.test.ts walks the output for money-named keys.

import { clockPlace } from "@/lib/clock-location";
import { dateKeyInBusinessTZ, formatTime, fromBusinessInputValue, shiftDateKey, startOfWeekKey } from "@/lib/date";

export type EntryTypeFilter = "all" | "work" | "travel";

export interface TimeLogFilters {
  /** First Melbourne day, YYYY-MM-DD, inclusive. */
  from: string;
  /** Last Melbourne day, YYYY-MM-DD, inclusive. */
  to: string;
  staffId: string | null;
  jobNumber: number | null;
  entryType: EntryTypeFilter;
}

/** The longest range one page will read — a backstop, not a business rule. */
export const MAX_RANGE_DAYS = 400;

const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isDateKey(v: unknown): v is string {
  if (typeof v !== "string" || !DATE_KEY.test(v)) return false;
  const [y, m, d] = v.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

function daysBetween(a: string, b: string): number {
  const [ay, am, ad] = a.split("-").map(Number);
  const [by, bm, bd] = b.split("-").map(Number);
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86_400_000);
}

/**
 * Read the page's query string. Default: this week (Mon–Sun, Melbourne).
 * A from after to is swapped; a range longer than MAX_RANGE_DAYS is cut back
 * from `from`. Anything unreadable is ignored, never an error.
 */
export function parseTimeLogFilters(
  params: { from?: string; to?: string; staff?: string; job?: string; type?: string },
  todayKey: string
): TimeLogFilters {
  const weekStart = startOfWeekKey(todayKey);
  let from = isDateKey(params.from) ? params.from : null;
  let to = isDateKey(params.to) ? params.to : null;
  if (!from && !to) {
    from = weekStart;
    to = shiftDateKey(weekStart, 6);
  } else if (!from) {
    from = to!;
  } else if (!to) {
    to = from;
  }
  if (from! > to!) [from, to] = [to, from];
  if (daysBetween(from!, to!) > MAX_RANGE_DAYS - 1) to = shiftDateKey(from!, MAX_RANGE_DAYS - 1);

  const staffId = typeof params.staff === "string" && UUID.test(params.staff) ? params.staff : null;
  const jobText = typeof params.job === "string" ? params.job.trim().replace(/^#/, "") : "";
  const jobNumber = /^\d{1,9}$/.test(jobText) ? Number(jobText) : null;
  const entryType: EntryTypeFilter = params.type === "work" || params.type === "travel" ? params.type : "all";
  return { from: from!, to: to!, staffId, jobNumber, entryType };
}

/** The instants the range covers: clock_in >= start and < end (Melbourne days). */
export function rangeInstants(filters: Pick<TimeLogFilters, "from" | "to">): { start: string; end: string } {
  return {
    start: fromBusinessInputValue(`${filters.from}T00:00`),
    end: fromBusinessInputValue(`${shiftDateKey(filters.to, 1)}T00:00`),
  };
}

/** One time_entries row as the page reads it (no rate column — it isn't readable). */
export interface TimeLogEntry {
  id: string;
  job_id: string | null;
  staff_id: string | null;
  clock_in: string;
  clock_out: string | null;
  hours: number | string | null;
  notes: string | null;
  auto_clocked: boolean | null;
  entry_type: string | null;
  cost_center_id: string | null;
  edited_by?: string | null;
  edited_at?: string | null;
  clock_in_lat?: number | null;
  clock_in_lng?: number | null;
  clock_in_accuracy?: number | null;
  clock_out_lat?: number | null;
  clock_out_lng?: number | null;
  clock_out_accuracy?: number | null;
  /** 0120 (draft) — absent on a database without it. */
  variation_id?: string | null;
}

export interface TimeLogSite {
  address_line1: string | null;
  suburb: string | null;
  site_lat: number | null;
  site_lng: number | null;
  geofence_radius_m: number | null;
}

export interface TimeLogJob {
  id: string;
  job_number: number;
  title: string | null;
  sites: TimeLogSite | null;
}

export interface TimeLogLookups {
  jobs: Map<string, TimeLogJob>;
  staffNames: Map<string, string>;
  /** po_cost_centers id → name (the job's stage / cost centre line). */
  stageNames: Map<string, string>;
  /** job_variations id → its name. */
  variationNames: Map<string, string>;
}

export interface PlaceFlag {
  label: string;
  outside: boolean;
}

export interface TimeLogRow {
  id: string;
  /** Melbourne day of the clock-on, YYYY-MM-DD. */
  date: string;
  staffId: string | null;
  staffName: string;
  jobId: string | null;
  jobNumber: number | null;
  jobTitle: string;
  site: string;
  stageName: string;
  variationName: string | null;
  entryType: "work" | "travel";
  clockIn: string;
  clockOut: string | null;
  stillOn: boolean;
  /** Closed: the entry's hours. Still on: time since clock-on, up to now. */
  hours: number;
  clockInPlace: PlaceFlag | null;
  clockOutPlace: PlaceFlag | null;
  auto: boolean;
  editedBy: string | null;
  notes: string;
}

export const NO_STAGE = "No cost centre";
export const TRAVEL_STAGE = "Travel";

function siteLabel(site: TimeLogSite | null | undefined): string {
  if (!site) return "";
  return [site.address_line1, site.suburb].map((s) => (s ?? "").trim()).filter(Boolean).join(", ");
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Shape the entries into report rows, oldest clock-on first. */
export function buildTimeLogRows(entries: readonly TimeLogEntry[], lookups: TimeLogLookups, nowMs = Date.now()): TimeLogRow[] {
  const rows = entries.map((e): TimeLogRow => {
    const job = e.job_id ? lookups.jobs.get(e.job_id) ?? null : null;
    const site = job?.sites ?? null;
    const entryType = e.entry_type === "travel" ? "travel" : "work";
    const stillOn = !e.clock_out;
    let hours: number;
    if (!stillOn && e.hours != null && Number.isFinite(Number(e.hours))) {
      hours = Number(e.hours);
    } else {
      const startMs = Date.parse(e.clock_in);
      const endMs = stillOn ? nowMs : Date.parse(e.clock_out!);
      hours = Number.isFinite(startMs) && Number.isFinite(endMs) && endMs > startMs ? (endMs - startMs) / 3_600_000 : 0;
    }
    // The fence check is about being at the job's site — travel is, by
    // definition, not there (as the job's Time tab).
    const pin = entryType === "work" && site ? { lat: site.site_lat, lng: site.site_lng, fenceM: site.geofence_radius_m } : null;
    const on = pin ? clockPlace({ lat: e.clock_in_lat, lng: e.clock_in_lng, accuracy: e.clock_in_accuracy }, pin) : null;
    const off = pin && e.clock_out ? clockPlace({ lat: e.clock_out_lat, lng: e.clock_out_lng, accuracy: e.clock_out_accuracy }, pin) : null;
    const stage = e.cost_center_id ? lookups.stageNames.get(e.cost_center_id) ?? NO_STAGE : NO_STAGE;
    return {
      id: e.id,
      date: dateKeyInBusinessTZ(e.clock_in),
      staffId: e.staff_id,
      staffName: (e.staff_id && lookups.staffNames.get(e.staff_id)) || "Unknown staff member",
      jobId: e.job_id,
      jobNumber: job?.job_number ?? null,
      jobTitle: job?.title ?? "",
      site: siteLabel(site),
      stageName: stage,
      variationName: e.variation_id ? lookups.variationNames.get(e.variation_id) ?? "Variation" : null,
      entryType,
      clockIn: e.clock_in,
      clockOut: e.clock_out,
      stillOn,
      hours: round2(hours),
      clockInPlace: on ? { label: on.label, outside: on.outside } : null,
      clockOutPlace: off ? { label: off.label, outside: off.outside } : null,
      auto: e.auto_clocked === true,
      editedBy: e.edited_by ? lookups.staffNames.get(e.edited_by) ?? "Office" : null,
      notes: (e.notes ?? "").trim(),
    };
  });
  return rows.sort((a, b) => a.clockIn.localeCompare(b.clockIn) || a.staffName.localeCompare(b.staffName) || a.id.localeCompare(b.id));
}

export interface StaffHours {
  staffId: string | null;
  name: string;
  hours: number;
  workHours: number;
  travelHours: number;
  entries: number;
}

export interface StageHours {
  name: string;
  hours: number;
  entries: number;
}

/** Hours per staff member, most hours first. */
export function hoursByStaff(rows: readonly TimeLogRow[]): StaffHours[] {
  const map = new Map<string, StaffHours>();
  for (const r of rows) {
    const key = r.staffId ?? "";
    const s = map.get(key) ?? { staffId: r.staffId, name: r.staffName, hours: 0, workHours: 0, travelHours: 0, entries: 0 };
    s.hours += r.hours;
    if (r.entryType === "travel") s.travelHours += r.hours;
    else s.workHours += r.hours;
    s.entries += 1;
    map.set(key, s);
  }
  return [...map.values()]
    .map((s) => ({ ...s, hours: round2(s.hours), workHours: round2(s.workHours), travelHours: round2(s.travelHours) }))
    .sort((a, b) => b.hours - a.hours || a.name.localeCompare(b.name));
}

/**
 * Hours per cost centre / stage name, most hours first. Travel is its own
 * line; work on a variation (0120) is under "Variation: <name>", since it
 * doesn't count toward the stage.
 */
export function hoursByStage(rows: readonly TimeLogRow[]): StageHours[] {
  const map = new Map<string, StageHours>();
  for (const r of rows) {
    const name = r.entryType === "travel" ? TRAVEL_STAGE : r.variationName ? `Variation: ${r.variationName}` : r.stageName;
    const s = map.get(name) ?? { name, hours: 0, entries: 0 };
    s.hours += r.hours;
    s.entries += 1;
    map.set(name, s);
  }
  return [...map.values()].map((s) => ({ ...s, hours: round2(s.hours) })).sort((a, b) => b.hours - a.hours || a.name.localeCompare(b.name));
}

export function sumHours(rows: readonly TimeLogRow[]): number {
  return round2(rows.reduce((s, r) => s + r.hours, 0));
}

export const CSV_COLUMNS = [
  "Date",
  "Staff",
  "Job number",
  "Job title",
  "Site",
  "Cost centre / stage",
  "Variation",
  "Type",
  "Clock on",
  "Clock off",
  "Hours",
  "Clock on place",
  "Clock off place",
  "Clocked by",
  "Edited by",
  "Notes",
] as const;

function csvCell(v: string | number | null | undefined): string {
  const s = v == null ? "" : String(v);
  // Leading = + - @ would run as a formula in a spreadsheet.
  const safe = /^[=+\-@]/.test(s) ? `'${s}` : s;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** Display text for a place flag, shared by the page and the CSV. Blank = no fix or no pin. */
export function placeLabel(p: PlaceFlag | null): string {
  if (!p) return "";
  return p.outside ? `Off site (${p.label})` : p.label === "on site" ? "On site" : `On site (${p.label})`;
}

/** The rows as CSV (Melbourne times), with a header line. */
export function timeLogCsv(rows: readonly TimeLogRow[]): string {
  const lines = [CSV_COLUMNS.join(",")];
  for (const r of rows) {
    lines.push(
      [
        r.date,
        r.staffName,
        r.jobNumber ?? "",
        r.jobTitle,
        r.site,
        r.stageName,
        r.variationName ?? "",
        r.entryType === "travel" ? "Travel" : "Work",
        formatTime(r.clockIn),
        r.stillOn ? "still on" : formatTime(r.clockOut!),
        r.hours.toFixed(2),
        placeLabel(r.clockInPlace),
        placeLabel(r.clockOutPlace),
        r.auto ? "Auto" : "Manual",
        r.editedBy ?? "",
        r.notes,
      ]
        .map(csvCell)
        .join(",")
    );
  }
  return lines.join("\r\n") + "\r\n";
}
