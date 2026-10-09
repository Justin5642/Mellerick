import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { Alert, AppState } from "react-native";
import * as Location from "expo-location";
import { supabase } from "./supabase";
import { listMyJobSites } from "./data/reads/jobs";
import { getOpenWorkEntry } from "./data/reads/clock";
import { onClockChanged } from "./clockEvents";
import {
  GATE_RECHECK_MS,
  decideTracking,
  hasOpenWorkInOutbox,
  isOnTheClock,
  trackingSettings,
  type TrackingSettings,
} from "./trackingGate";
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
import {
  startBackgroundClock,
  stopBackgroundClock,
  publishBackgroundClockContext,
  publishOnTheClock,
  readBackgroundGeofenceState,
  startSiteWake,
  stopSiteWake,
} from "./backgroundClock";
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

/** `enabled`: the gate currently has location tracking running. */
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
  const { session, profile } = useAuth();
  // The geofence writes through the SAME durable outbox as the manual clock
  // button. Before this it wrote straight to Supabase, so an automatic clock-in
  // or clock-out made with no signal was discarded silently — the one path that
  // fires when nobody is looking at the screen was the one that could not survive
  // being offline.
  const layer = useDataLayer();
  const userId = session?.user.id ?? null;
  const role = profile?.role ?? null;

  const sitesRef = useRef<TrackedSite[]>([]);
  const insideJobIdRef = useRef<string | null>(null);
  const departureRef = useRef<PendingDeparture | null>(null);
  const busyRef = useRef(false);
  // This provider renders no UI, so a modal is the only surface it has. Once per
  // session is the whole point of the ref: the site refresh retries every ten
  // minutes, and an alert that reappears on a timer is one the technician learns
  // to dismiss without reading.
  const autoClockAlertedRef = useRef(false);

  // ---------------------------------------------------------------------------
  // THE GATE: whether tracking runs at all, and how hard (lib/trackingGate.ts).
  //
  // Tracking used to start for every signed-in user and run until sign-out —
  // office phones, technicians with nothing scheduled, nights and weekends. It
  // now runs only for a technician with a geofence-able site who is on the clock
  // or inside work hours, and is re-decided on app foreground, on every site
  // refresh, on every clock-in/out queued on this device, after every geofence
  // transition, and every GATE_RECHECK_MS in case the hour boundary passes.
  //
  // Being on the clock overrides the hours. That is the payroll rule: a job
  // that runs late still gets its departure and its drive recorded.
  // ---------------------------------------------------------------------------
  const subscriptionRef = useRef<Location.LocationSubscription | null>(null);
  const foregroundKeyRef = useRef<string | null>(null);
  const askedForegroundRef = useRef(false);
  const backgroundOffLoggedRef = useRef(false);
  const evaluateRef = useRef<() => void>(() => {});
  // The gate reads these from async callbacks; refs keep them current there.
  const layerRef = useRef(layer);
  layerRef.current = layer;
  const [tracking, setTracking] = useState(false);
  // False until the first site load succeeds. "No sites" stops tracking, but
  // "not loaded yet" must not: at launch that would stop a background task that
  // is mid-shift, only to restart it a moment later — and a stop discards any
  // readings the OS is still holding.
  const sitesLoadedRef = useRef(false);

  // Keep the list of this tech's active job sites fresh.
  useEffect(() => {
    sitesLoadedRef.current = false;
    if (!userId) {
      sitesRef.current = [];
      return;
    }
    let cancelled = false;

    async function loadSites() {
      // Local-first (reads/jobs.ts listMyJobSites), and scoped to every job the
      // technician is on — crew jobs included, not just those where they are
      // jobs.assigned_to's primary. The assigned_to-only filter this replaces
      // meant the second technician on a crew job never had its site
      // geofenced, so their arrival and travel there were never auto-recorded.
      const sites = await listMyJobSites(userId as string);
      if (cancelled) return;

      sitesRef.current = sites;
      sitesLoadedRef.current = true;

      // Hand the same list to the background task. It runs with no React tree
      // and cannot fetch this itself, so the foreground is the only place that
      // can keep it current — and a stale list is what makes a technician
      // arrive at a new job the task has never heard of.
      publishBackgroundClockContext(userId, sitesRef.current).catch((e) =>
        console.warn("[geofence] could not publish background context:", e)
      );

      // Whether there is any site at all is one of the gate's inputs.
      evaluateRef.current();
    }

    // A failed refresh KEEPS the sites we already had. Blanking them on a
    // transient error would silently switch the auto-clock off for the rest of
    // the shift — and because nextGeofenceState treats an empty list as "not
    // loaded yet" (correctly, so it never fabricates a clock-out), the failure
    // would be completely invisible: no error, no clock-in, no travel time, just
    // quietly unpaid hours. There is one case that policy cannot cover: a FIRST
    // load that fails leaves no list at all, and an empty list reads downstream
    // as "not loaded yet", so the auto-clock never engages for the entire shift.
    // There is no screen anywhere that would show that, which is precisely why
    // it has to be said out loud.
    function refreshSites() {
      loadSites().catch((e) => {
        if (cancelled) return;
        console.warn("[geofence] could not refresh job sites; keeping the previous list:", e);
        if (sitesRef.current.length > 0 || autoClockAlertedRef.current) return;
        autoClockAlertedRef.current = true;
        Alert.alert(
          "Automatic clock in/out isn't running",
          "Your job sites couldn't be loaded, so arrivals and travel time won't be recorded on their own. Clock in and out by hand until this clears."
        );
      });
    }

    refreshSites();
    const interval = setInterval(refreshSites, 10 * 60 * 1000);
    // A job assigned while the app was in the background should be geofenced
    // as soon as the technician looks at the phone, not up to ten minutes later.
    // Cheap now that the read is local-first.
    const appState = AppState.addEventListener("change", (state) => {
      if (state === "active") refreshSites();
    });
    return () => {
      cancelled = true;
      clearInterval(interval);
      appState.remove();
    };
  }, [userId]);

  useEffect(() => {
    if (!userId) return;
    const staffId = userId;
    let disposed = false;
    // Evaluations are serialised: two overlapping ones could interleave a start
    // and a stop and leave the watcher in whichever state lost the race.
    let chain = Promise.resolve();

    function stopForeground() {
      subscriptionRef.current?.remove();
      subscriptionRef.current = null;
      foregroundKeyRef.current = null;
    }

    async function readOnTheClock(now: Date): Promise<{ onTheClock: boolean; onSite: boolean }> {
      let storageFailed = false;
      const [openWorkEntry, ops, background] = await Promise.all([
        getOpenWorkEntry(staffId).catch(() => "unknown" as const),
        (layerRef.current?.outbox.snapshot() ?? Promise.resolve([])).catch(() => []),
        readBackgroundGeofenceState().catch(() => {
          storageFailed = true;
          return { insideJobId: null, pendingDeparture: null, siteWakeAt: null };
        }),
      ]);
      // Either watcher's view counts: the foreground cursor and the background
      // task's persisted one are separate state machines over the same sites.
      const insideJobId = insideJobIdRef.current ?? background.insideJobId;
      const foregroundDeparture = departureRef.current
        ? { jobId: departureRef.current.jobId, at: departureRef.current.timeIso }
        : null;
      const signals = {
        openWorkEntry,
        openWorkInOutbox: hasOpenWorkInOutbox(ops, staffId),
        insideJobId,
        siteWakeAt: background.siteWakeAt,
        nowMs: now.getTime(),
      };
      const onTheClock =
        storageFailed ||
        isOnTheClock({ ...signals, pendingDeparture: foregroundDeparture }) ||
        isOnTheClock({ ...signals, pendingDeparture: background.pendingDeparture });
      return { onTheClock, onSite: insideJobId !== null };
    }

    async function startForeground(settings: TrackingSettings): Promise<boolean> {
      const options = {
        accuracy: Location.Accuracy.Balanced,
        timeInterval: settings.timeIntervalMs,
        distanceInterval: settings.distanceIntervalM,
      };
      const key = JSON.stringify(options);
      if (subscriptionRef.current && key === foregroundKeyRef.current) return true;

      // Asked once per session, then only read: this runs every few minutes,
      // and a permission prompt on a timer is one people stop reading.
      const { status } = askedForegroundRef.current
        ? await Location.getForegroundPermissionsAsync()
        : await Location.requestForegroundPermissionsAsync();
      askedForegroundRef.current = true;
      if (status !== "granted" || disposed) return false;

      const subscription = await Location.watchPositionAsync(options, (position) => handlePosition(position, staffId));
      if (disposed) {
        subscription.remove();
        return false;
      }
      stopForeground();
      subscriptionRef.current = subscription;
      foregroundKeyRef.current = key;
      return true;
    }

    async function applyGate() {
      // No decision until the site list has loaded once — see sitesLoadedRef.
      if (disposed || !sitesLoadedRef.current) return;
      const now = new Date();
      const { onTheClock, onSite } = await readOnTheClock(now);
      if (disposed) return;
      const decision = decideTracking({ userId: staffId, role, siteCount: sitesRef.current.length, onTheClock, now });

      // For the background task's own stop check, which runs headless and
      // cannot see the mirror, the outbox or the foreground cursor.
      publishOnTheClock(onTheClock).catch((e) => console.warn("[geofence] could not publish clock state:", e));

      if (!decision.track) {
        stopForeground();
        setTracking(false);
        await stopBackgroundClock().catch((e) => console.warn("[geofence] could not stop background tracking:", e));
        // Off hours the wake regions are what bring tracking back for the next
        // arrival, even if the app is never opened (trackingGate.ts). For any
        // other reason there is nothing to wake for.
        await (decision.reason === "off-hours" ? startSiteWake(sitesRef.current) : stopSiteWake()).catch((e) =>
          console.warn("[geofence] could not update wake regions:", e)
        );
        return;
      }

      const settings = trackingSettings(decision.mode, onSite);

      // The whole start is guarded. Declining the permission is a return, not a
      // throw, so this catch only fires when the watcher genuinely could not
      // start — and that is the total loss of the auto-clock, not the partial
      // one the background gap causes below.
      try {
        if (!(await startForeground(settings))) {
          setTracking(false);
          return;
        }
        setTracking(true);
      } catch (e) {
        // Nothing on screen changes when this throws: no spinner, no empty
        // state, just hours that quietly never get recorded and are missed a
        // fortnight later on a payslip. A log line does not reach a technician
        // in a basement, so the one available surface gets used instead.
        if (disposed) return;
        console.warn("[geofence] foreground watcher failed to start:", e);
        if (autoClockAlertedRef.current) return;
        autoClockAlertedRef.current = true;
        Alert.alert(
          "Automatic clock in/out isn't running",
          `Location tracking couldn't start, so arrivals and travel time won't be recorded on their own. Clock in and out by hand until this clears.${
            e instanceof Error && e.message ? `\n\n${e.message}` : ""
          }`
        );
        return;
      }

      // Background tracking too. Declining "Always" is fine and expected — the
      // foreground watcher above still works, so the app degrades to exactly
      // the behaviour it had before. What it must never do is fail silently,
      // hence the log: a technician who declined "Always" is not having their
      // drive time recorded, and somebody should be able to find out why. Once
      // per session, now that this re-runs every few minutes.
      if (disposed) return;
      const started = await startBackgroundClock(settings).catch((e) => {
        console.warn("[geofence] background clock failed to start:", e);
        return false;
      });
      if (!started && !backgroundOffLoggedRef.current) {
        backgroundOffLoggedRef.current = true;
        console.warn(
          "[geofence] background tracking NOT active — travel time is only recorded while the app is open."
        );
      }

      // Registered while tracking too (after the "Always" prompt above), so
      // they are already in place when the gate next stops — see startSiteWake
      // for why they are not toggled with tracking.
      if (disposed) return;
      await startSiteWake(sitesRef.current).catch((e) => console.warn("[geofence] could not update wake regions:", e));
    }

    const evaluate = () => {
      chain = chain.then(applyGate).catch((e) => console.warn("[geofence] tracking gate failed:", e));
    };
    evaluateRef.current = evaluate;

    evaluate();
    const interval = setInterval(evaluate, GATE_RECHECK_MS);
    const appState = AppState.addEventListener("change", (state) => {
      if (state === "active") evaluate();
    });
    const unsubscribeClock = onClockChanged(evaluate);

    return () => {
      disposed = true;
      evaluateRef.current = () => {};
      clearInterval(interval);
      appState.remove();
      unsubscribeClock();
      stopForeground();
      setTracking(false);
    };
  }, [userId, role]);

  // Separately from location: drain the outbox periodically while the app is
  // CLOSED. Queued writes otherwise wait for someone to reopen the app, which
  // after a late job may be the next morning. Not gated on tracking — an office
  // user's queued writes need delivering too.
  useEffect(() => {
    if (!userId) return;
    startBackgroundSync(true).catch((e) => console.warn("[sync] background drain not registered:", e));
  }, [userId]);

  // Signing out stops background tracking and clears the cached context. Leaving
  // it running would keep writing time entries against the previous user.
  useEffect(() => {
    if (userId) return;
    stopBackgroundClock().catch(() => {});
    stopSiteWake().catch(() => {});
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
    // Read through the ref: the watcher's callback outlives the render that
    // created it, and a captured null would make this bail for the whole session.
    const layer = layerRef.current;
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

      // Only consulted on an arrival (see GeofenceTransitionInput), but looked
      // up from the same site list either way rather than threading insideJobId
      // separately.
      const targetSite = sites.find((s) => s.jobId === target);

      const result = await applyGeofenceTransition(
        {
          kind: insideJobId ? "arrival" : "departure",
          jobId: target,
          staffId,
          pendingDeparture: departureRef.current,
          costCenterId: targetSite?.scheduledCostCenterId ?? null,
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
      // Arriving or leaving changes the tracking profile (on site vs between
      // sites); the clock write itself also re-triggers via clockEvents.
      evaluateRef.current();
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


  return <LocationTrackingContext.Provider value={{ enabled: tracking }}>{children}</LocationTrackingContext.Provider>;
}

export function useLocationTracking() {
  return useContext(LocationTrackingContext);
}
