import * as Location from "expo-location";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { planBackgroundClockActions, type LocationReading, type PendingDeparture } from "./backgroundClockPlan";
import type { TrackedSite } from "./geofenceState";
import {
  GATE_RECHECK_MS,
  decideTracking,
  isOnTheClock,
  trackingSettings,
  wakeRegions,
  type TrackingDecision,
  type TrackingSettings,
} from "./trackingGate";

// Background half of the geofence auto-clock.
//
// The foreground watcher (lib/location-tracking.tsx) only runs while the app is
// open. A technician who pockets the phone and drives to the next site has that
// travel time silently NOT recorded — no error, no log, just hours that never
// appear on the payslip. This closes that gap.
//
// DELIBERATELY THIN. All the decision-making lives in backgroundClockPlan.ts,
// which is pure and unit-tested, because nothing in this file can be tested
// without a device: TaskManager.defineTask must run at module scope, the OS
// decides when to deliver, and the process may be killed between deliveries.
// Everything that CAN be a pure function is one.
//
// STATE ACROSS INVOCATIONS. The task may be started, killed and restarted by the
// OS, so "which site am I inside" cannot live in memory. It is persisted here
// and read back on each delivery. Losing it degrades safely: an unknown previous
// site means the next arrival simply has no travel leg to attribute, which
// under-reports one drive rather than fabricating anything.

export const BACKGROUND_CLOCK_TASK = "mellerick-background-clock";
/** OS region monitoring that restarts tracking off hours — see trackingGate.ts. */
export const SITE_WAKE_TASK = "mellerick-site-wake";

const INSIDE_KEY = "mellerick.backgroundClock.insideJobId";
const SITES_KEY = "mellerick.backgroundClock.sites";
const STAFF_KEY = "mellerick.backgroundClock.staffId";
const DEPARTURE_KEY = "mellerick.backgroundClock.pendingDeparture";
const ON_THE_CLOCK_KEY = "mellerick.backgroundClock.onTheClock";
const WAKE_AT_KEY = "mellerick.backgroundClock.siteWakeAt";
const WAKE_REGIONS_KEY = "mellerick.backgroundClock.wakeRegions";

export interface BackgroundClockDeps {
  readInside(): Promise<string | null>;
  writeInside(jobId: string | null): Promise<void>;
  /**
   * The departure awaiting the arrival that closes it into a travel leg.
   *
   * Persisted for the same reason insideJobId is: the OS kills and restarts this
   * task freely, so a drive beginning in one delivery and ending in the next is
   * the normal case. Without it a leg could only be attributed within a single
   * batch, and since the state machine reports A->away->B as separate
   * transitions, that meant never.
   */
  readPendingDeparture(): Promise<PendingDeparture | null>;
  writePendingDeparture(departure: PendingDeparture | null): Promise<void>;
  readSites(): Promise<TrackedSite[]>;
  readStaffId(): Promise<string | null>;
  onArrive(
    jobId: string,
    at: string,
    fromJobId: string | null,
    /** When the previous site was left — the travel leg's start. */
    fromAt: string | null,
    staffId: string,
    /** The arriving job's scheduled stage. */
    costCenterId: string | null
  ): Promise<void>;
  onDepart(jobId: string, at: string, staffId: string): Promise<void>;
}

/**
 * Apply a delivered batch. Exported so the task body stays a one-liner and the
 * orchestration can be exercised with fakes.
 */
export async function applyBackgroundBatch(
  batch: LocationReading[],
  deps: BackgroundClockDeps
): Promise<void> {
  const staffId = await deps.readStaffId();
  // Signed out. Do nothing at all — writing time entries for a user who is no
  // longer authenticated is worse than missing the readings.
  if (!staffId) return;

  const [sites, previousInside, previousDeparture] = await Promise.all([
    deps.readSites(),
    deps.readInside(),
    deps.readPendingDeparture(),
  ]);
  const plan = planBackgroundClockActions(batch, sites, previousInside, previousDeparture);

  // Actions are applied in order and SEQUENTIALLY: a depart must land before the
  // arrival that follows it, or the technician is briefly clocked in at two jobs
  // and the reconciliation picks an arbitrary winner.
  for (const action of plan.actions) {
    if (action.type === "depart") {
      await deps.onDepart(action.jobId, action.at, staffId);
    } else {
      await deps.onArrive(action.jobId, action.at, action.fromJobId, action.fromAt, staffId, action.costCenterId);
    }
  }

  // Persisted only AFTER the writes are enqueued. If the process dies partway,
  // the stale value makes the next batch re-derive the same transition — a
  // duplicate the write path already de-duplicates — rather than skipping it,
  // which would lose the entry outright. Re-doing beats losing for payroll.
  if (plan.insideJobId !== previousInside) {
    await deps.writeInside(plan.insideJobId);
  }
  if (plan.pendingDeparture?.at !== previousDeparture?.at || plan.pendingDeparture?.jobId !== previousDeparture?.jobId) {
    await deps.writePendingDeparture(plan.pendingDeparture);
  }
}

export const storageDeps = {
  readInside: async () => AsyncStorage.getItem(INSIDE_KEY),
  writeInside: async (jobId: string | null) =>
    jobId === null ? AsyncStorage.removeItem(INSIDE_KEY) : AsyncStorage.setItem(INSIDE_KEY, jobId),
  readPendingDeparture: async (): Promise<PendingDeparture | null> => {
    const raw = await AsyncStorage.getItem(DEPARTURE_KEY);
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw);
      // A corrupt value must not fabricate a leg from a bogus timestamp; treat
      // it as "no departure pending" and lose one leg rather than invent one.
      return typeof parsed?.jobId === "string" && typeof parsed?.at === "string" ? parsed : null;
    } catch {
      return null;
    }
  },
  writePendingDeparture: async (departure: PendingDeparture | null) =>
    departure === null
      ? AsyncStorage.removeItem(DEPARTURE_KEY)
      : AsyncStorage.setItem(DEPARTURE_KEY, JSON.stringify(departure)),
  readSites: async (): Promise<TrackedSite[]> => {
    const raw = await AsyncStorage.getItem(SITES_KEY);
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      // Corrupt cache reads as "not loaded", which the planner treats as "do
      // nothing" rather than "clock out everywhere".
      return [];
    }
  },
  readStaffId: async () => AsyncStorage.getItem(STAFF_KEY),
};

/**
 * Publish the data the background task needs. Called from the foreground
 * provider, which is the only place that knows the session and the job list.
 */
export async function publishBackgroundClockContext(staffId: string | null, sites: TrackedSite[]): Promise<void> {
  if (!staffId) {
    await AsyncStorage.multiRemove([STAFF_KEY, SITES_KEY, INSIDE_KEY, DEPARTURE_KEY, ON_THE_CLOCK_KEY, WAKE_AT_KEY]);
    return;
  }
  await AsyncStorage.setItem(STAFF_KEY, staffId);
  await AsyncStorage.setItem(SITES_KEY, JSON.stringify(sites));
}

/**
 * The foreground gate's latest "on the clock" verdict, for the background task's
 * own stop check (backgroundTrackingDecision). The foreground sees signals the
 * task cannot — the mirror, the outbox, its own geofence cursor — so it hands
 * the combined answer over rather than leaving the task to guess.
 */
export async function publishOnTheClock(onTheClock: boolean, now: Date = new Date()): Promise<void> {
  await AsyncStorage.setItem(ON_THE_CLOCK_KEY, JSON.stringify({ onTheClock, at: now.toISOString() }));
}

/**
 * How long a published verdict stands. The foreground republishes it every
 * GATE_RECHECK_MS while its JS context lives; once the app has been swiped
 * away it stops, and a "yes" frozen at 18:00 would otherwise hold GPS on all
 * night. Past this the task decides from its own state alone — which covers
 * everything background readings can still record (a departure needs "inside",
 * a travel leg a pending departure, an off-hours arrival the wake regions).
 */
export const PUBLISHED_VERDICT_TTL_MS = 3 * GATE_RECHECK_MS;

/** The published verdict if it is still current, else null. Exported for tests. */
export function parsePublishedVerdict(raw: string | null, nowMs: number): boolean | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    const at = Date.parse(parsed?.at);
    if (typeof parsed?.onTheClock !== "boolean" || Number.isNaN(at)) return null;
    // A future stamp means the clock moved back; it stays current until the
    // clock catches up, which errs toward tracking and is bounded by the jump.
    return nowMs - at < PUBLISHED_VERDICT_TTL_MS ? parsed.onTheClock : null;
  } catch {
    return null;
  }
}

export interface BackgroundGateDeps {
  readStaffId(): Promise<string | null>;
  readSites(): Promise<TrackedSite[]>;
  readInside(): Promise<string | null>;
  readPendingDeparture(): Promise<PendingDeparture | null>;
  /** The foreground's verdict while current (parsePublishedVerdict), else null. */
  readOnTheClock(now: Date): Promise<boolean | null>;
  readSiteWakeAt(): Promise<string | null>;
}

/**
 * Should the background task keep running after this delivery?
 *
 * The foreground provider makes this decision while the JS context is alive,
 * but the OS can keep delivering to the task headless — app swiped away, no
 * React tree — and then nothing would ever stop it. So the task asks the same
 * question of the same pure function (trackingGate.decideTracking) after each
 * batch. It only ever STOPS here; restarting is the wake task's job.
 *
 * Its view of "on the clock" is the foreground's current verdict, OR the task's
 * own persisted state, which can be fresher (it is written by the delivery that
 * just ran). Role is not re-checked: only a technician's session starts the
 * task, and sign-out clears the staff id this reads.
 */
export async function backgroundTrackingDecision(deps: BackgroundGateDeps, now: Date): Promise<TrackingDecision> {
  const [staffId, sites, inside, departure, published, siteWakeAt] = await Promise.all([
    deps.readStaffId(),
    deps.readSites(),
    deps.readInside(),
    deps.readPendingDeparture(),
    deps.readOnTheClock(now),
    deps.readSiteWakeAt(),
  ]);
  const onTheClock =
    published === true ||
    isOnTheClock({
      openWorkEntry: null,
      openWorkInOutbox: false,
      insideJobId: inside,
      pendingDeparture: departure,
      siteWakeAt,
      nowMs: now.getTime(),
    });
  return decideTracking({
    userId: staffId,
    role: staffId ? "technician" : null,
    siteCount: sites.length,
    onTheClock,
    now,
  });
}

export const backgroundGateDeps: BackgroundGateDeps = {
  readStaffId: storageDeps.readStaffId,
  readSites: storageDeps.readSites,
  readInside: storageDeps.readInside,
  readPendingDeparture: storageDeps.readPendingDeparture,
  readOnTheClock: async (now) => parsePublishedVerdict(await AsyncStorage.getItem(ON_THE_CLOCK_KEY), now.getTime()),
  readSiteWakeAt: async () => AsyncStorage.getItem(WAKE_AT_KEY),
};

/** The background side's persisted state, for the foreground gate's on-the-clock check. */
export async function readBackgroundGeofenceState(): Promise<{
  insideJobId: string | null;
  pendingDeparture: PendingDeparture | null;
  siteWakeAt: string | null;
}> {
  const [insideJobId, pendingDeparture, siteWakeAt] = await Promise.all([
    storageDeps.readInside(),
    storageDeps.readPendingDeparture(),
    backgroundGateDeps.readSiteWakeAt(),
  ]);
  return { insideJobId, pendingDeparture, siteWakeAt };
}

/** expo-location's options for a gate profile. */
export function toLocationOptions(settings: TrackingSettings): Location.LocationTaskOptions {
  return {
    accuracy: Location.Accuracy.Balanced,
    timeInterval: settings.timeIntervalMs,
    distanceInterval: settings.distanceIntervalM,
    deferredUpdatesInterval: settings.deferredUpdatesIntervalMs,
    deferredUpdatesDistance: settings.deferredUpdatesDistanceM,
    activityType:
      settings.activityType === "automotiveNavigation" ? Location.ActivityType.AutomotiveNavigation : Location.ActivityType.Other,
    pausesUpdatesAutomatically: settings.pausesUpdatesAutomatically,
  };
}

// The options the running task was last started with, so a re-evaluation that
// lands on the same profile is a no-op rather than a restart. Module state, not
// persisted: after a relaunch the first evaluation restarts once, harmlessly.
let appliedOptionsKey: string | null = null;

// Background permission is REQUESTED at most once per app session, then only
// read. The gate re-evaluates every few minutes, and on Android 11+ each request
// sends the technician to a settings page — a prompt that reappears on a timer
// is one people learn to dismiss without reading.
let askedBackgroundPermission = false;

/**
 * Start (or retune) background tracking. Returns false when "Always" is not
 * granted — the foreground watcher still works without it.
 *
 * `prompt: false` never asks, only reads: for the headless wake task, which has
 * no screen to show a permission dialog on.
 */
export async function startBackgroundClock(
  settings: TrackingSettings,
  opts: { prompt?: boolean } = {}
): Promise<boolean> {
  // Foreground must be granted first — the OS rejects the background request
  // otherwise, and expo's docs are explicit about the ordering.
  const fg = await Location.getForegroundPermissionsAsync();
  if (fg.status !== "granted") return false;

  const ask = (opts.prompt ?? true) && !askedBackgroundPermission;
  const bg = ask ? await Location.requestBackgroundPermissionsAsync() : await Location.getBackgroundPermissionsAsync();
  if (ask) askedBackgroundPermission = true;
  if (bg.status !== "granted") return false;

  const options = toLocationOptions(settings);
  const key = JSON.stringify(options);
  const running = await Location.hasStartedLocationUpdatesAsync(BACKGROUND_CLOCK_TASK);
  if (running && key === appliedOptionsKey) return true;

  // Starting an already-registered task re-registers it with the new options;
  // the foreground service notification stays up across the change.
  await Location.startLocationUpdatesAsync(BACKGROUND_CLOCK_TASK, {
    ...options,
    // Android requires a visible notification for background location. This is
    // also the honest thing to do: the technician can see that the app is
    // tracking, which is the difference between a feature and surveillance.
    // It now comes and goes with the gate, so it is up only while tracking is.
    foregroundService: {
      notificationTitle: "Mellerick is recording your job time",
      notificationBody: "Automatic clock in and out while you are on site.",
      notificationColor: "#2563eb",
    },
  });
  appliedOptionsKey = key;
  return true;
}

/** Stops the task, and with it the Android foreground service. */
export async function stopBackgroundClock(): Promise<void> {
  appliedOptionsKey = null;
  if (await Location.hasStartedLocationUpdatesAsync(BACKGROUND_CLOCK_TASK)) {
    await Location.stopLocationUpdatesAsync(BACKGROUND_CLOCK_TASK);
  }
}

/**
 * Register the sites as OS wake regions (trackingGate.ts, OFF-HOURS WAKE
 * REGIONS). Kept registered whenever a technician has sites, tracking or not,
 * so the OS's own inside/outside state stays continuous: every registration
 * makes both platforms report an Enter for any region the phone is already in,
 * so re-registering on every gate pass would wake the app for nothing. It is
 * therefore skipped when the same regions are already registered.
 *
 * Needs "Always" — without it the regions could not fire in the background, and
 * this returns false: the app then behaves as it did with background tracking
 * declined, which is already logged.
 */
export async function startSiteWake(sites: TrackedSite[]): Promise<boolean> {
  const regions = wakeRegions(sites);
  if (regions.length === 0) {
    await stopSiteWake();
    return false;
  }
  const bg = await Location.getBackgroundPermissionsAsync();
  if (bg.status !== "granted") return false;

  const key = JSON.stringify(regions);
  const [registered, previousKey] = await Promise.all([
    Location.hasStartedGeofencingAsync(SITE_WAKE_TASK),
    AsyncStorage.getItem(WAKE_REGIONS_KEY),
  ]);
  if (registered && previousKey === key) return true;

  await Location.startGeofencingAsync(SITE_WAKE_TASK, regions);
  await AsyncStorage.setItem(WAKE_REGIONS_KEY, key);
  return true;
}

export async function stopSiteWake(): Promise<void> {
  await AsyncStorage.removeItem(WAKE_REGIONS_KEY);
  if (await Location.hasStartedGeofencingAsync(SITE_WAKE_TASK)) {
    await Location.stopGeofencingAsync(SITE_WAKE_TASK);
  }
}

export interface SiteWakeDeps {
  isTracking(): Promise<boolean>;
  readStaffId(): Promise<string | null>;
  writeSiteWakeAt(iso: string): Promise<void>;
  startTracking(settings: TrackingSettings): Promise<boolean>;
}

/**
 * A wake region was entered. When tracking is already running — inside work
 * hours, or on the clock — this does nothing: the readings are already flowing.
 * Otherwise it stamps the wake (which the gate counts as on the clock for
 * WAKE_GRACE_MS, so neither stop check undoes it before the arrival lands) and
 * restarts tracking in the between-sites profile. (The OS fires these coarse
 * and late, so the clock events still come from the ordinary 150 m readings.)
 *
 * Exits are not acted on: leaving a site is only payroll while on the clock,
 * and then tracking is already running.
 */
export async function handleSiteWake(eventType: number, deps: SiteWakeDeps, now: Date = new Date()): Promise<void> {
  if (eventType !== Location.GeofencingEventType.Enter) return;
  if (!(await deps.readStaffId())) return;
  if (await deps.isTracking()) return;
  await deps.writeSiteWakeAt(now.toISOString());
  const started = await deps.startTracking(trackingSettings("on-the-clock", false));
  if (!started) console.warn("[backgroundClock] site wake could not restart tracking (permission?)");
}

export const siteWakeDeps: SiteWakeDeps = {
  isTracking: () => Location.hasStartedLocationUpdatesAsync(BACKGROUND_CLOCK_TASK),
  readStaffId: storageDeps.readStaffId,
  writeSiteWakeAt: (iso) => AsyncStorage.setItem(WAKE_AT_KEY, iso),
  startTracking: (settings) => startBackgroundClock(settings, { prompt: false }),
};

/** Test seam: forget per-session state. */
export function resetBackgroundClockForTests(): void {
  appliedOptionsKey = null;
  askedBackgroundPermission = false;
}
