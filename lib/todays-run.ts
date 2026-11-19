// "Today's run" — a truck driver's run sheet (19 Nov 2026; no migration).
//
// Justin: a driver booked on cartage floats between several jobs in a day —
// rock to Job A, rock in and dirt out at Job B, back to Job A. The phone's
// run screen lists every job they are carting for today and logs a load
// against any of them in one tap. GET /api/runs/today builds it; these are
// its pure rules (tests/unit/todays-run.test.ts).
//
// WHICH BOOKINGS COUNT. One of the caller's OWN bookings (job_bookings.
// staff_id = them) that is booked on today's Melbourne day by the 0071 day
// rules (lib/scheduling.ts occupiesDay via bookingWindow — never by
// starts_at alone), whose cost centre is cartage. A booking's cost centre is
// a job PO line (job_bookings.cost_center_id → po_cost_centers.id); the line
// is cartage when the COMPANY cost centre it is tagged with
// (po_cost_centers.cost_centre_id → cost_centres, 0087) is "Transport" or
// "Truck Cartage" (0108) — the same two names 0111's
// cartage_load_cost_centre() falls back to. A line the office never tagged
// falls back to its own name, with 0087's keyword rule (the one that tagged
// the existing lines Transport). A tagged line is never second-guessed by its
// name. A booking with no cost centre is not cartage.
//
// No money here: totals are quantities and km only.

import { bookingWindow, type JobBooking } from "./bookings";
import { scheduleDays } from "./scheduling";
import type { LoadDirection, LoadStatus, LoadUnit } from "./cartage-pricing";

/** Company cost centres that are cartage (lower-cased, trimmed). */
export const CARTAGE_COST_CENTRES = ["transport", "truck cartage"] as const;
/** 0087's keyword rule for lines with no company cost centre. */
const CARTAGE_LINE_NAME = /(cartage|truck|transport|quarter|tipping)/i;

/** A job PO line as the route reads it: its own name and its company cost centre's name. */
export interface RunLine {
  id: string;
  name: string | null;
  /** cost_centres.name, or null when the line isn't tagged. */
  costCentre: string | null;
}

export function isCartageLine(line: RunLine | null | undefined): boolean {
  if (!line) return false;
  const tagged = (line.costCentre ?? "").trim().toLowerCase();
  if (tagged) return (CARTAGE_COST_CENTRES as readonly string[]).includes(tagged);
  return CARTAGE_LINE_NAME.test(line.name ?? "");
}

export type RunBooking = Pick<JobBooking, "id" | "job_id" | "staff_id" | "cost_center_id" | "starts_at" | "ends_at" | "daily" | "all_day">;

export interface RunSlot {
  bookingId: string;
  /** Today's block of the booking (a daily booking's hours on today). */
  startIso: string;
  endIso: string;
  allDay: boolean;
  /** Company cost centre's name, else the line's. */
  costCentre: string | null;
  /** The job's PO line (stage) name, when it differs from the cost centre. */
  stage: string | null;
}

/** The caller's own cartage bookings on `todayKey`, each as today's block, earliest first. */
export function cartageSlotsToday(bookings: readonly RunBooking[], lines: ReadonlyMap<string, RunLine>, userId: string, todayKey: string): (RunSlot & { jobId: string })[] {
  const out: (RunSlot & { jobId: string })[] = [];
  for (const b of bookings) {
    if (!userId || b.staff_id !== userId || !b.cost_center_id) continue;
    const line = lines.get(b.cost_center_id);
    if (!isCartageLine(line)) continue;
    const day = scheduleDays(bookingWindow(b)).find((d) => d.dateKey === todayKey);
    if (!day) continue;
    const costCentre = line!.costCentre?.trim() || line!.name?.trim() || null;
    const stage = line!.name?.trim() || null;
    out.push({
      jobId: b.job_id,
      bookingId: b.id,
      startIso: day.startIso,
      endIso: day.endIso,
      allDay: b.all_day,
      costCentre,
      stage: stage && stage !== costCentre ? stage : null,
    });
  }
  return out.sort((a, b) => a.startIso.localeCompare(b.startIso) || a.bookingId.localeCompare(b.bookingId));
}

/**
 * The run's jobs in order: booked jobs by their earliest block today, then
 * jobs with no cartage booking today that the caller logged a load on today
 * (a job they added to the run with "+ Add a job"), by job number.
 */
export function runJobOrder(
  slots: readonly (RunSlot & { jobId: string })[],
  loggedJobIds: readonly string[],
  jobNumber: (jobId: string) => number,
): { jobId: string; booked: boolean }[] {
  const order: { jobId: string; booked: boolean }[] = [];
  const seen = new Set<string>();
  for (const s of [...slots].sort((a, b) => a.startIso.localeCompare(b.startIso) || jobNumber(a.jobId) - jobNumber(b.jobId))) {
    if (seen.has(s.jobId)) continue;
    seen.add(s.jobId);
    order.push({ jobId: s.jobId, booked: true });
  }
  for (const id of [...new Set(loggedJobIds)].filter((id) => !seen.has(id)).sort((a, b) => jobNumber(a) - jobNumber(b))) {
    order.push({ jobId: id, booked: false });
  }
  return order;
}

export interface DirectionTotals {
  /** Trips (loads logged), whatever they were measured in. */
  trips: number;
  tonnes: number;
  m3: number;
  /** Quantity measured in "loads". */
  loadUnits: number;
  km: number;
  /** Materials named on material-in loads, first seen first. */
  materials: string[];
}

export interface RunTotals {
  in: DirectionTotals;
  out: DirectionTotals;
  trips: number;
  tonnes: number;
  m3: number;
  km: number;
}

export interface TotalsLoad {
  direction: LoadDirection;
  unit: LoadUnit;
  quantity: number | null;
  km: number | null;
  material: string | null;
  status: LoadStatus;
}

const round = (n: number) => Math.round(n * 100) / 100;

function emptyDirection(): DirectionTotals {
  return { trips: 0, tonnes: 0, m3: 0, loadUnits: 0, km: 0, materials: [] };
}

/** Totals of the given loads, void ones left out. Quantities and km only. */
export function runTotals(loads: readonly TotalsLoad[]): RunTotals {
  const t = { in: emptyDirection(), out: emptyDirection() };
  for (const l of loads) {
    if (l.status === "void") continue;
    const d = l.direction === "material_in" ? t.in : t.out;
    d.trips += 1;
    const q = l.quantity ?? 0;
    if (l.unit === "tonne") d.tonnes += q;
    else if (l.unit === "m3") d.m3 += q;
    else d.loadUnits += q;
    d.km += l.km ?? 0;
    const m = l.material?.trim();
    if (l.direction === "material_in" && m && !d.materials.some((x) => x.toLowerCase() === m.toLowerCase())) d.materials.push(m);
  }
  for (const d of [t.in, t.out]) {
    d.tonnes = round(d.tonnes);
    d.m3 = round(d.m3);
    d.loadUnits = round(d.loadUnits);
    d.km = round(d.km);
  }
  return {
    ...t,
    trips: t.in.trips + t.out.trips,
    tonnes: round(t.in.tonnes + t.out.tonnes),
    m3: round(t.in.m3 + t.out.m3),
    km: round(t.in.km + t.out.km),
  };
}

/** Today's Melbourne "YYYY-MM-DD" from an instant. */
export function melbourneDateKey(now: Date): string {
  return now.toLocaleDateString("en-CA", { timeZone: "Australia/Melbourne" });
}
