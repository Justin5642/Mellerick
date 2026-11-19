import { call, type LoadBilling, type LoadDirection, type TruckLoad } from "./truckLoads";

// "Today's run" — the truck driver's run sheet (19 Nov 2026; no migration).
// Justin: a driver booked on cartage floats between jobs in a day — rock to
// Job A, on to Job B, back to Job A. My Jobs shows a "Today's run (N jobs)"
// card when they have a cartage booking today; the run screen lists every job
// they are carting for today with one-tap load logging on each.
//
// Reads come from GET /api/runs/today (which bookings count, and why the
// server decides: lib/todays-run.ts on the web). Writes are the job's own
// Truck loads routes (lib/truckLoads.ts). ONLINE ONLY, like Truck loads.
//
// THE MONEY RULE: the run sheet carries quantities only, for everyone — no
// rate, cost or price in the answer (tests/unit/todays-run-route.test.ts).

export const TODAYS_RUN_OFFLINE = "Today's run needs signal. Try again when you have it.";

export interface RunDirectionTotals {
  trips: number;
  tonnes: number;
  m3: number;
  loadUnits: number;
  km: number;
  materials: string[];
}

export interface RunTotals {
  in: RunDirectionTotals;
  out: RunDirectionTotals;
  trips: number;
  tonnes: number;
  m3: number;
  km: number;
}

export interface RunSlot {
  bookingId: string;
  startIso: string;
  endIso: string;
  allDay: boolean;
  costCentre: string | null;
  stage: string | null;
}

export interface RunSite {
  address_line1: string | null;
  suburb: string | null;
  state: string | null;
  site_lat: number | null;
  site_lng: number | null;
}

export interface RunJob {
  id: string;
  jobNumber: number;
  title: string;
  status: string;
  customer: string | null;
  site: RunSite | null;
  siteLabel: string | null;
  /** False = not booked for cartage today; on the run because a load was logged on it today. */
  booked: boolean;
  slots: RunSlot[];
  quarryIncluded: boolean | null;
  defaults: Record<LoadDirection, LoadBilling>;
  loads: TruckLoad[];
  totals: RunTotals;
}

export interface RunOtherJob {
  id: string;
  jobNumber: number;
  title: string;
  customer: string | null;
  siteLabel: string | null;
  quarryIncluded: boolean | null;
  defaults: Record<LoadDirection, LoadBilling>;
}

export type TodaysRunState =
  | { ready: false; date: string; jobCount: number }
  | {
      ready: true;
      date: string;
      trucks: { id: string; name: string }[];
      suppliers: { id: string; name: string; pinOrder: number | null }[];
      jobs: RunJob[];
      totals: RunTotals;
      otherJobs: RunOtherJob[];
    };

export function loadTodaysRun(): Promise<TodaysRunState> {
  return call("/api/runs/today");
}

/** My Jobs' card: how many open jobs the caller is booked on for cartage today. */
export async function loadTodaysRunCount(): Promise<number> {
  const res = await call<{ jobCount?: number }>("/api/runs/today?summary=1");
  return typeof res.jobCount === "number" ? res.jobCount : 0;
}

export function isRunOffline(e: unknown): boolean {
  return e instanceof Error && e.message.startsWith("No connection.");
}

// ---------------------------------------------------------------------------
// Pure helpers for the screen and the card.
// ---------------------------------------------------------------------------

export function runCardTitle(jobCount: number): string {
  return `Today's run (${jobCount} job${jobCount === 1 ? "" : "s"})`;
}

const n = (v: number) => (Number.isInteger(v) ? String(v) : String(Math.round(v * 100) / 100));

/** "3 loads · 36 t · 9 m³ · 90 km" — what was carted, never a price. Empty when nothing yet. */
export function totalsText(t: Pick<RunDirectionTotals, "trips" | "tonnes" | "m3" | "km"> & { loadUnits?: number }): string {
  if (t.trips === 0) return "";
  const parts = [`${t.trips} load${t.trips === 1 ? "" : "s"}`];
  if (t.tonnes > 0) parts.push(`${n(t.tonnes)} t`);
  if (t.m3 > 0) parts.push(`${n(t.m3)} m³`);
  if (t.km > 0) parts.push(`${n(t.km)} km`);
  return parts.join(" · ");
}

/** "7:00 am – 3:30 pm · Transport", or "All day · Transport", in Melbourne time. */
export function slotText(s: RunSlot): string {
  const time = (iso: string) => new Date(iso).toLocaleTimeString("en-AU", { hour: "numeric", minute: "2-digit", timeZone: "Australia/Melbourne" });
  const when = s.allDay ? "All day" : `${time(s.startIso)} – ${time(s.endIso)}`;
  return [when, s.costCentre, s.stage].filter(Boolean).join(" · ");
}

/** Today's draft EXTRA loads on this job, waiting for the builder's signature. */
export function draftExtras(job: Pick<RunJob, "loads">, date: string): TruckLoad[] {
  return job.loads.filter((l) => l.load_date === date && l.status === "draft" && l.billing === "extra");
}

/** The form's context for a job on the run (names only). */
export function formContextFor(
  run: Extract<TodaysRunState, { ready: true }>,
  job: Pick<RunJob, "quarryIncluded" | "siteLabel">
): { trucks: { id: string; name: string }[]; suppliers: { id: string; name: string; pinOrder: number | null }[]; quarryIncluded: boolean | null; siteLabel: string | null } {
  return { trucks: run.trucks, suppliers: run.suppliers, quarryIncluded: job.quarryIncluded, siteLabel: job.siteLabel };
}
