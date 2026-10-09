import type { Operation, WriteOperation } from "./data/outbox/types";
import type { PendingDeparture } from "./backgroundClockPlan";
import { GEOFENCE_RADIUS_METERS, type TrackedSite } from "./geofenceState";
import { MAX_PLAUSIBLE_TRAVEL_HOURS, MAX_PLAUSIBLE_WORK_HOURS } from "./autoClockHours";

// WHEN location tracking runs, and HOW hard — as pure functions.
//
// Tracking used to start for ANY signed-in user and stop only on sign-out: the
// office manager's phone, a technician with nothing scheduled, and every phone
// overnight and all weekend kept GPS and an Android foreground service running.
// That is battery spent on readings the auto-clock can do nothing with.
//
// But the auto-clock is a PAYROLL feature (HANDOVER §7). A gate that switched
// it off while a technician was still working would bring back the exact
// failure background tracking was built to remove: hours that silently never
// appear. So every rule below fails toward TRACKING when it cannot tell, and
// "on the clock" beats every other rule, including the time of day.
//
// Pure so it can be unit-tested — the native side (lib/location-tracking.tsx,
// lib/backgroundClock.ts) cannot be exercised without a technician driving
// between two sites — and so the foreground provider and the background task
// make the same decision from the same function.

/**
 * When a technician who is NOT on the clock is still worth watching for an
 * arrival. Device-local time; `days` uses Date#getDay (0 = Sunday).
 *
 * Deliberately generous at both ends: a start before 06:00 or a finish after
 * 19:00 is still recorded in full, because being on the clock overrides this
 * window entirely. It only decides when to watch for a FIRST arrival.
 */
export const WORK_HOURS: WorkHours = { startHour: 6, endHour: 19, days: [1, 2, 3, 4, 5, 6] };

/**
 * How often the gate re-decides on its own, on top of the event triggers (app
 * foreground, site refresh, clock-in/out, geofence transition). This is what
 * notices the work-hours boundary pass — but only while the JS context is
 * running, which on iOS means while tracking is on or the app is open. The
 * off-hours wake regions (below) cover a phone that is never opened.
 */
export const GATE_RECHECK_MS = 5 * 60 * 1000;

export interface WorkHours {
  /** First hour (0–23) inside the window. */
  startHour: number;
  /** First hour (0–24) after the window — 19 means "until 18:59:59". */
  endHour: number;
  days: number[];
}

export function isWithinWorkHours(now: Date, hours: WorkHours = WORK_HOURS): boolean {
  if (!hours.days.includes(now.getDay())) return false;
  const h = now.getHours();
  return h >= hours.startHour && h < hours.endHour;
}

export type TrackingMode =
  /** Working or between jobs: every departure and travel leg matters. */
  | "on-the-clock"
  /** Inside work hours, not working: only an arrival needs to be noticed. */
  | "watching";

export type TrackingStopReason = "signed-out" | "not-technician" | "no-sites" | "off-hours";

export type TrackingDecision = { track: true; mode: TrackingMode } | { track: false; reason: TrackingStopReason };

export interface TrackingInputs {
  userId: string | null;
  role: string | null | undefined;
  /** Geofence-able sites for this technician's open jobs. */
  siteCount: number;
  onTheClock: boolean;
  now: Date;
  hours?: WorkHours;
}

export function decideTracking(i: TrackingInputs): TrackingDecision {
  if (!i.userId) return { track: false, reason: "signed-out" };
  // Office and admin are never auto-clocked: the geofence writes technician
  // time entries, so there is nothing for their readings to do.
  //
  // An UNKNOWN role (profile still loading, or its read failed — a technician
  // launching the app with no signal) is not a reason to stop: it fails toward
  // tracking, as before the gate existed. The site list still has to be
  // non-empty, and an office user rarely has jobs of their own.
  if (i.role != null && i.role !== "technician") return { track: false, reason: "not-technician" };
  // No site, no geofence. nextGeofenceState treats an empty list as "not loaded"
  // and does nothing with any reading, so tracking here — even on the clock —
  // could not record anything; it would only spend the battery.
  if (i.siteCount === 0) return { track: false, reason: "no-sites" };
  // On the clock beats the time of day. A job that runs to 21:00 must still get
  // its departure and the drive to the next site recorded.
  if (i.onTheClock) return { track: true, mode: "on-the-clock" };
  if (isWithinWorkHours(i.now, i.hours)) return { track: true, mode: "watching" };
  return { track: false, reason: "off-hours" };
}

export interface ClockSignals {
  /**
   * The clock-in of this technician's latest open work entry, from the mirror
   * or the network; null when there is none, "unknown" when neither could
   * answer — treated as on the clock.
   */
  openWorkEntry: { clockInIso: string } | null | "unknown";
  /** An open work entry still sitting in the outbox (offline clock-in). */
  openWorkInOutbox: boolean;
  /** The geofence (foreground or background) believes we are inside a site. */
  insideJobId: string | null;
  /** A departure not yet closed by an arrival — a drive in progress. */
  pendingDeparture: PendingDeparture | null;
  /** When an off-hours wake region last fired (see wakeRegions), if ever. */
  siteWakeAt: string | null;
  nowMs: number;
}

/**
 * "On the clock" for the gate: any sign that hours are being, or are about to
 * be, recorded. Several signals because each one alone has a blind spot:
 *
 *  - the mirror lags an offline clock-in until the outbox drains → the outbox;
 *  - a clock-in the geofence just made has not reached either yet → insideJobId;
 *  - BETWEEN sites nothing is open at all, yet the drive is the very thing
 *    background tracking exists to record → a fresh pendingDeparture.
 */
export function isOnTheClock(s: ClockSignals): boolean {
  if (s.openWorkEntry === "unknown") return true;
  if (s.openWorkEntry && isStintPlausible(s.openWorkEntry.clockInIso, s.nowMs)) return true;
  if (s.openWorkInOutbox) return true;
  if (s.insideJobId) return true;
  if (isWithinWindow(s.siteWakeAt, WAKE_GRACE_MS, s.nowMs)) return true;
  return isDriveInProgress(s.pendingDeparture, s.nowMs);
}

const MAX_TRAVEL_MS = MAX_PLAUSIBLE_TRAVEL_HOURS * 60 * 60 * 1000;
const MAX_WORK_MS = MAX_PLAUSIBLE_WORK_HOURS * 60 * 60 * 1000;

/**
 * An entry open longer than the work ceiling is a forgotten clock-out, not a
 * shift (autoClockHours.ts) — and without this, one forgotten button press kept
 * GPS running around the clock for days. Past the ceiling the gate falls back
 * to the ordinary rules, so in work hours that technician is still watched.
 * Unparseable, or stamped in the future (the clock moved): counted as open.
 */
function isStintPlausible(clockInIso: string, nowMs: number): boolean {
  const at = Date.parse(clockInIso);
  if (Number.isNaN(at)) return true;
  return nowMs - at < MAX_WORK_MS;
}

/**
 * A departure is worth tracking for as long as the leg it would close could
 * still be believed. Past the travel ceiling, plausibleAutoClockHours discards
 * the leg anyway, so tracking on would record nothing.
 *
 * A departure stamped in the FUTURE means the device clock moved backwards.
 * Elsewhere that case is released (HANDOVER §3), because there the wrong answer
 * is a stall; here the wrong answer is a lost drive, while staying on costs only
 * battery — and the leg stays bounded, since the clock catches up.
 */
export function isDriveInProgress(departure: PendingDeparture | null, nowMs: number): boolean {
  return isWithinWindow(departure?.at ?? null, MAX_TRAVEL_MS, nowMs);
}

function isWithinWindow(atIso: string | null, windowMs: number, nowMs: number): boolean {
  if (!atIso) return false;
  const at = Date.parse(atIso);
  if (Number.isNaN(at)) return false;
  return nowMs - at < windowMs;
}

// ---------------------------------------------------------------------------
// OFF-HOURS WAKE REGIONS
//
// Stopping GPS off hours has a cost the gate alone cannot pay back: on iOS an
// app cannot start location updates from the background on its own, and
// Android restricts starting the foreground service from there. So a
// technician who never opens the app on a morning would be watched again only
// when they did — and their first arrival of the day would not be clocked.
// Before the gate, tracking simply never stopped, so that would be a regression.
//
// OS region monitoring closes it. While the gate is off for "off-hours", the
// sites are registered as regions; the OS watches them on cell/wifi at
// negligible cost with no notification, and relaunches the app into the
// background on approach. The wake handler restarts tracking (Android exempts
// a geofence transition from its background-start restriction; iOS permits it
// with "Always"), and the ordinary path then records the arrival. Region
// monitoring is deliberately NOT the clock itself: OS region events are
// coarse and late (often hundreds of metres), and the payroll times come from
// the same 150 m readings as always.
// ---------------------------------------------------------------------------

/** Wider than the geofence, so tracking is up before the 150 m circle is crossed. */
export const WAKE_REGION_RADIUS_M = GEOFENCE_RADIUS_METERS * 2;

/** iOS monitors at most 20 regions per app (Android allows 100). */
export const MAX_WAKE_REGIONS = 20;

/**
 * How long a wake counts as "on the clock". Long enough to cover the approach
 * from the region edge, park and be read inside the geofence; short enough that
 * driving past a site at night costs a few minutes of GPS, not an evening.
 */
export const WAKE_GRACE_MS = 20 * 60 * 1000;

export interface WakeRegion {
  identifier: string;
  latitude: number;
  longitude: number;
  radius: number;
  notifyOnEnter: true;
  notifyOnExit: false;
}

/**
 * Sites as wake regions. Callers pass the site list in schedule order
 * (listMyJobSites sorts soonest first), so past the iOS cap it is the latest
 * and unscheduled jobs that go unwatched off hours.
 */
export function wakeRegions(sites: TrackedSite[]): WakeRegion[] {
  return sites.slice(0, MAX_WAKE_REGIONS).map((s) => ({
    identifier: s.jobId,
    latitude: s.lat,
    longitude: s.lng,
    radius: WAKE_REGION_RADIUS_M,
    notifyOnEnter: true,
    notifyOnExit: false,
  }));
}

/**
 * An open work entry this technician created on this device that the server
 * (and so the mirror) may not have yet: a time_entries insert with no clock_out
 * that is still queued, and that no queued update or delete has since closed.
 */
export function hasOpenWorkInOutbox(ops: Operation[], staffId: string): boolean {
  const live = ops.filter(
    (o): o is WriteOperation => o.kind === "write" && o.table === "time_entries" && o.status !== "done" && o.status !== "dead"
  );
  const closed = new Set(
    live.filter((o) => o.op === "delete" || (o.op === "update" && o.payload.clock_out != null)).map((o) => o.rowId)
  );
  return live.some(
    (o) =>
      o.op === "insert" &&
      o.payload.staff_id === staffId &&
      o.payload.clock_out == null &&
      (o.payload.entry_type ?? "work") === "work" &&
      !closed.has(o.rowId)
  );
}

/**
 * Platform-neutral location settings; lib/backgroundClock.ts maps them onto
 * expo-location's enums so this file stays testable without the native module.
 */
export interface TrackingSettings {
  /**
   * Always "balanced" (~100 m). Lower is not offered on purpose: expo's Low is
   * ~1 km and Lowest ~3 km, against a 150 m geofence. A reading that far off can
   * place a technician inside a site they are not at — a FABRICATED clock-in —
   * or miss the arrival entirely. The savings come from frequency instead.
   */
  accuracy: "balanced";
  timeIntervalMs: number;
  distanceIntervalM: number;
  /** Background only — batches JS wake-ups; the GPS duty cycle is unchanged. */
  deferredUpdatesIntervalMs: number;
  deferredUpdatesDistanceM: number;
  /** iOS only. */
  activityType: "automotiveNavigation" | "other";
  /**
   * iOS only. Always false: once iOS pauses updates, expo-location does not
   * resume them (it gets no didPause callback to act on), and only
   * significant-change readings (~500 m, cell-tower grade) keep arriving. A
   * technician parked on site long enough to pause would then have their
   * departure noticed late and the arrival at the next site missed — a whole
   * visit and a travel leg gone.
   */
  pausesUpdatesAutomatically: false;
}

/**
 * How hard to track. `onSite` is whether the geofence has us inside a site.
 *
 * DEFERRAL ONLY ON SITE. expo-location's deferral holds readings in memory until
 * both its interval and distance have elapsed, and DROPS them if tracking stops
 * first. Off site, a held reading can be the arrival — and if the gate then
 * stops tracking (hours end, the drive's ceiling passes) the visit is lost
 * outright. On site the next transition is a departure, which means movement,
 * which flushes the batch; and while inside a site the gate never stops. So the
 * distance threshold stays 0 and the interval is short, and readings still carry
 * their own timestamps — the background planner stamps each clock event with
 * its reading's time, so a batch delivered late is still recorded on time.
 */
export function trackingSettings(mode: TrackingMode, onSite: boolean): TrackingSettings {
  if (mode === "watching") {
    // Waiting for an arrival. Half the cadence of the on-the-clock profile; the
    // distance filter is NOT loosened, because the last reading before a
    // technician parks is what has to land inside the 150 m circle.
    return {
      accuracy: "balanced",
      timeIntervalMs: 30_000,
      distanceIntervalM: 25,
      deferredUpdatesIntervalMs: 0,
      deferredUpdatesDistanceM: 0,
      activityType: "other",
      pausesUpdatesAutomatically: false,
    };
  }
  // On the clock: the profile that shipped before the gate existed, unchanged
  // off site. Departure and arrival times are payroll.
  return {
    accuracy: "balanced",
    timeIntervalMs: 15_000,
    distanceIntervalM: 25,
    deferredUpdatesIntervalMs: onSite ? 60_000 : 0,
    deferredUpdatesDistanceM: 0,
    activityType: onSite ? "other" : "automotiveNavigation",
    pausesUpdatesAutomatically: false,
  };
}
