import * as Location from "expo-location";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { planBackgroundClockActions, type LocationReading, type PendingDeparture } from "./backgroundClockPlan";
import type { TrackedSite } from "./geofenceState";

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

const INSIDE_KEY = "mellerick.backgroundClock.insideJobId";
const SITES_KEY = "mellerick.backgroundClock.sites";
const STAFF_KEY = "mellerick.backgroundClock.staffId";
const DEPARTURE_KEY = "mellerick.backgroundClock.pendingDeparture";

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
    staffId: string
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
      await deps.onArrive(action.jobId, action.at, action.fromJobId, action.fromAt, staffId);
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
    await AsyncStorage.multiRemove([STAFF_KEY, SITES_KEY, INSIDE_KEY, DEPARTURE_KEY]);
    return;
  }
  await AsyncStorage.setItem(STAFF_KEY, staffId);
  await AsyncStorage.setItem(SITES_KEY, JSON.stringify(sites));
}

export async function startBackgroundClock(): Promise<boolean> {
  // Foreground must be granted first — the OS rejects the background request
  // otherwise, and expo's docs are explicit about the ordering.
  const fg = await Location.requestForegroundPermissionsAsync();
  if (fg.status !== "granted") return false;

  const bg = await Location.requestBackgroundPermissionsAsync();
  if (bg.status !== "granted") return false;

  if (await Location.hasStartedLocationUpdatesAsync(BACKGROUND_CLOCK_TASK)) return true;

  await Location.startLocationUpdatesAsync(BACKGROUND_CLOCK_TASK, {
    accuracy: Location.Accuracy.Balanced,
    // Matched to the foreground watcher so the two behave the same. A tighter
    // interval would drain the battery for no extra fidelity at a 150m radius.
    timeInterval: 15000,
    distanceInterval: 25,
    pausesUpdatesAutomatically: false,
    // Android requires a visible notification for background location. This is
    // also the honest thing to do: the technician can see that the app is
    // tracking, which is the difference between a feature and surveillance.
    foregroundService: {
      notificationTitle: "Mellerick is recording your job time",
      notificationBody: "Automatic clock in and out while you are on site.",
      notificationColor: "#2563eb",
    },
  });
  return true;
}

export async function stopBackgroundClock(): Promise<void> {
  if (await Location.hasStartedLocationUpdatesAsync(BACKGROUND_CLOCK_TASK)) {
    await Location.stopLocationUpdatesAsync(BACKGROUND_CLOCK_TASK);
  }
}
