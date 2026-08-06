import { createContext, useContext, useEffect, useRef, type ReactNode } from "react";
import * as Location from "expo-location";
import { supabase } from "./supabase";
import { useAuth } from "./auth-context";
import { useDataLayer } from "./data/DataProvider";
import type { DataLayer } from "./data/createDataLayer";

import { nextGeofenceState, type TrackedSite } from "./geofenceState";
import {
  applyGeofenceTransition,
  type GeofenceTransitionDeps,
  type OpenEntryLookup,
  type PendingDeparture,
} from "./geofenceTransition";
import { netInfoConnectivity } from "./data/net/connectivity";
import { powersync } from "../powersync/db";
import { startBackgroundClock, stopBackgroundClock, publishBackgroundClockContext } from "./backgroundClock";
import { startBackgroundSync, stopBackgroundSync } from "./backgroundSync";

// GEOFENCE_RADIUS_METERS and the distance maths now live in ./geofenceState,
// shared with the background task so the two paths cannot disagree about what
// "on site" means.

// Plausibility ceilings for both auto-clocked durations live in
// ./autoClockHours, together with the reasoning: a gap longer than the travel
// ceiling is a backgrounded app rather than drive time, and a work stint longer
// than its ceiling is a departure event that never fired.

// Billing sync is NOT fired from here. TimeEntriesRepository.clockIn/clockOut/
// addManual each enqueue a sync-billing side-effect through the outbox
// (enqueueBillingSync), so it survives being offline. A local syncBilling()
// helper used to sit here doing it by hand over fetch; it had already stopped
// being called by the time the writes moved to the outbox, and was removed
// rather than left as a second, non-durable path someone might revive.

const LocationTrackingContext = createContext<{ enabled: boolean }>({ enabled: false });

/**
 * App-wide geofence watcher for auto clock in/out + travel-time logging.
 *
 * TWO WATCHERS, ONE DECISION. The foreground watcher below (watchPositionAsync)
 * runs while the app is open; lib/backgroundClockTask.ts continues when it is
 * not. Both route through nextGeofenceState, so they cannot disagree about what
 * "on site" means.
 *
 * This used to be foreground-only, and the gap was invisible rather than
 * cosmetic: a technician who pocketed the phone and drove to the next site had
 * that travel time silently NOT recorded — no error, no log, just hours missing
 * from the payslip. Background tracking needs "Always" location, a foreground
 * service notification on Android, and a dev/EAS build (Expo Go cannot do it).
 *
 * Background is BEST-EFFORT: a technician may decline "Always", in which case
 * the foreground watcher alone still works and the app behaves exactly as it did
 * before. That case is logged rather than swallowed, because "your drive time is
 * not being recorded" is something someone must be able to discover.
 */
export function LocationTrackingProvider({ children }: { children: ReactNode }) {
  const { session } = useAuth();
  // The geofence writes through the SAME durable outbox as the manual clock
  // button. Before this it wrote straight to Supabase, so an automatic clock-in
  // or clock-out made with no signal was discarded silently — the one path that
  // fires when nobody is looking at the screen was the one that could not survive
  // being offline.
  const layer = useDataLayer();
  const userId = session?.user.id ?? null;

  const sitesRef = useRef<TrackedSite[]>([]);
  const insideJobIdRef = useRef<string | null>(null);
  const departureRef = useRef<PendingDeparture | null>(null);
  const busyRef = useRef(false);

  // Keep the list of this tech's active job sites fresh.
  useEffect(() => {
    if (!userId) {
      sitesRef.current = [];
      return;
    }
    let cancelled = false;

    async function loadSites() {
      const { data, error } = await supabase
        .from("jobs")
        .select("id, status, sites(site_lat, site_lng)")
        .eq("assigned_to", userId)
        .not("status", "in", '("completed","cancelled")');
      if (cancelled) return;

      // A failed refresh KEEPS the sites we already had. Blanking them on a
      // transient network error would silently switch the auto-clock off for
      // the rest of the shift — and because nextGeofenceState treats an empty
      // list as "not loaded yet" (correctly, so it never fabricates a
      // clock-out), the failure would be completely invisible: no error, no
      // clock-in, no travel time, just quietly unpaid hours.
      if (error) {
        console.warn("[geofence] could not refresh job sites; keeping the previous list:", error.message);
        return;
      }

      sitesRef.current = (data ?? [])
        .filter((j: any) => j.sites?.site_lat && j.sites?.site_lng)
        .map((j: any) => ({ jobId: j.id, lat: j.sites.site_lat, lng: j.sites.site_lng }));

      // Hand the same list to the background task. It runs with no React tree
      // and cannot fetch this itself, so the foreground is the only place that
      // can keep it current — and a stale list is what makes a technician
      // arrive at a new job the task has never heard of.
      publishBackgroundClockContext(userId, sitesRef.current).catch((e) =>
        console.warn("[geofence] could not publish background context:", e)
      );
    }

    loadSites();
    const interval = setInterval(loadSites, 10 * 60 * 1000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [userId]);

  // Watch position and drive the geofence state machine.
  useEffect(() => {
    if (!userId) return;
    let subscription: Location.LocationSubscription | null = null;
    let cancelled = false;

    (async () => {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== "granted" || cancelled) return;
      subscription = await Location.watchPositionAsync(
        { accuracy: Location.Accuracy.Balanced, timeInterval: 15000, distanceInterval: 25 },
        (position) => handlePosition(position, userId)
      );

      // Ask for background tracking too. Declining is fine and expected — the
      // foreground watcher above still works, so the app degrades to exactly
      // the behaviour it had before. What it must never do is fail silently,
      // hence the log: a technician who declined "Always" is not having their
      // drive time recorded, and somebody should be able to find out why.
      if (cancelled) return;
      const started = await startBackgroundClock().catch((e) => {
        console.warn("[geofence] background clock failed to start:", e);
        return false;
      });
      if (!started) {
        console.warn(
          "[geofence] background tracking NOT active — travel time is only recorded while the app is open."
        );
      }

      // Separately from location: drain the outbox periodically while the app
      // is CLOSED. Queued writes otherwise wait for someone to reopen the app,
      // which after a late job may be the next morning.
      startBackgroundSync(true).catch((e) => console.warn("[sync] background drain not registered:", e));
    })();

    return () => {
      cancelled = true;
      subscription?.remove();
    };
  }, [userId]);

  // Signing out stops background tracking and clears the cached context. Leaving
  // it running would keep writing time entries against the previous user.
  useEffect(() => {
    if (userId) return;
    stopBackgroundClock().catch(() => {});
    stopBackgroundSync().catch(() => {});
    publishBackgroundClockContext(null, []).catch(() => {});
  }, [userId]);

  async function handlePosition(position: Location.LocationObject, staffId: string) {
    if (busyRef.current) return;
    const sites = sitesRef.current;
    if (sites.length === 0) return;

    // Bail BEFORE the cursor moves. The data layer is null only for the moment
    // between app start and its SQLite store opening; returning here leaves
    // insideJobIdRef untouched, so the next position update re-derives the same
    // transition. Bailing after the cursor advanced would consume the arrival
    // and never write it — losing the visit rather than delaying it.
    if (!layer) return;

    // Same decision the background task uses (lib/geofenceState.ts) — the two
    // must not drift, or the auto-clock would behave differently depending on
    // whether the technician happened to have the app open.
    const next = nextGeofenceState(position.coords, sites, insideJobIdRef.current);
    if (next.transition === "none") return;

    const { insideJobId, previousJobId } = next;
    const previousCursor = insideJobIdRef.current;
    insideJobIdRef.current = insideJobId;
    busyRef.current = true;
    try {
      const target = insideJobId ?? previousJobId;
      if (!target) return;

      const result = await applyGeofenceTransition(
        {
          kind: insideJobId ? "arrival" : "departure",
          jobId: target,
          staffId,
          pendingDeparture: departureRef.current,
        },
        makeTransitionDeps(layer)
      );

      // THE CURSOR IS ONLY CONSUMED ON A DURABLE CONCLUSION.
      //
      // Restoring it here is the fix for the defect that lost whole visits: the
      // old code advanced the cursor and then bailed when the offline
      // idempotence read failed, so every later reading computed "none" and the
      // clock-in was never re-derived. Putting the cursor back means the next
      // position update derives the same transition and tries again.
      if (!result.handled) {
        insideJobIdRef.current = previousCursor;
        return;
      }

      if (result.clearPendingDeparture) departureRef.current = null;
      if (result.setPendingDeparture) departureRef.current = result.setPendingDeparture;
    } finally {
      busyRef.current = false;
    }
  }

  // The idempotence lookup, LOCAL-FIRST.
  //
  // The network read alone is what made the technician's offline arrival
  // unresolvable. The on-device PowerSync mirror already carries this
  // technician's own time entries, so offline it can answer the question
  // authoritatively — and only when BOTH the network and the mirror are
  // unavailable does this return "unknown" and leave the transition pending.
  async function findOpenEntry(jobId: string, staffId: string): Promise<OpenEntryLookup> {
    if (await netInfoConnectivity.isOnline()) {
      const { data, error } = await supabase
        .from("time_entries")
        .select("id, clock_in")
        .eq("job_id", jobId)
        .eq("staff_id", staffId)
        .eq("entry_type", "work")
        .is("clock_out", null)
        .maybeSingle();
      if (!error) {
        return data ? { status: "found", entryId: data.id, clockInIso: data.clock_in } : { status: "none" };
      }
      // Network answered with an error — fall through to the mirror rather
      // than giving up, which is what lost the visit.
    }

    try {
      if (!powersync.currentStatus?.hasSynced) return { status: "unknown", reason: "mirror not synced" };
      const rows = await powersync.getAll<{ id: string; clock_in: string }>(
        `SELECT id, clock_in FROM time_entries
          WHERE job_id = ? AND staff_id = ? AND entry_type = 'work' AND clock_out IS NULL
          LIMIT 1`,
        [jobId, staffId]
      );
      const row = rows[0];
      return row ? { status: "found", entryId: row.id, clockInIso: row.clock_in } : { status: "none" };
    } catch (e) {
      return { status: "unknown", reason: e instanceof Error ? e.message : "local mirror unavailable" };
    }
  }

  function makeTransitionDeps(layer: DataLayer): GeofenceTransitionDeps {
    return {
      findOpenEntry,
      // autoClocked: the geofence started this, not the technician. The
      // background task records the same flag, so both paths now agree.
      clockIn: (input) => layer.timeEntries.clockIn({ ...input, autoClocked: true }),
      clockOut: (input) => layer.timeEntries.clockOut(input),
      addTravelLeg: async (input) => {
        await layer.timeEntries.addManual({
          jobId: input.jobId,
          staffId: input.staffId,
          clockInIso: input.clockInIso,
          clockOutIso: input.clockOutIso,
          entryType: "travel",
          costCenterId: null,
          travelFromJobId: input.travelFromJobId,
          autoClocked: true,
        });
      },
      nowIso: () => new Date().toISOString(),
      onWarn: (message) => console.warn(message),
    };
  }


  return <LocationTrackingContext.Provider value={{ enabled: !!userId }}>{children}</LocationTrackingContext.Provider>;
}

export function useLocationTracking() {
  return useContext(LocationTrackingContext);
}
