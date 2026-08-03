import { createContext, useContext, useEffect, useRef, type ReactNode } from "react";
import * as Location from "expo-location";
import { supabase } from "./supabase";
import { useAuth } from "./auth-context";
import { useDataLayer } from "./data/DataProvider";
import type { DataLayer } from "./data/createDataLayer";
import { plausibleAutoClockHours, MAX_PLAUSIBLE_TRAVEL_HOURS, MAX_PLAUSIBLE_WORK_HOURS } from "./autoClockHours";
import { nextGeofenceState, type TrackedSite } from "./geofenceState";
import { startBackgroundClock, stopBackgroundClock, publishBackgroundClockContext } from "./backgroundClock";

// GEOFENCE_RADIUS_METERS and the distance maths now live in ./geofenceState,
// shared with the background task so the two paths cannot disagree about what
// "on site" means.

// Plausibility ceilings for both auto-clocked durations live in
// ./autoClockHours, together with the reasoning: a gap longer than the travel
// ceiling is a backgrounded app rather than drive time, and a work stint longer
// than its ceiling is a departure event that never fired.

const API_BASE_URL = process.env.EXPO_PUBLIC_API_BASE_URL;

// Fire-and-forget: regenerates the job's auto-generated labour line item
// (see app/api/time-entries/[id]/sync-billing/route.ts) right after this
// geofence watcher writes a time_entries row -- mirrors the same call in
// mobile/components/job/time.tsx's manual clock in/out UI. Needs the Bearer
// token (no web session cookie here) since job_items writes are Admin-only
// RLS and the route authenticates the caller itself.
function syncBilling(entryId: string) {
  if (!API_BASE_URL) return;
  supabase.auth.getSession().then(({ data }) => {
    const token = data.session?.access_token;
    if (!token) return;
    fetch(`${API_BASE_URL}/api/time-entries/${entryId}/sync-billing`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    }).catch(() => {});
  });
}

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
  const departureRef = useRef<{ time: string; jobId: string } | null>(null);
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
    insideJobIdRef.current = insideJobId;
    busyRef.current = true;
    try {
      if (insideJobId) {
        await handleArrival(layer, insideJobId, staffId);
      } else if (previousJobId) {
        await handleDeparture(layer, previousJobId, staffId);
      }
    } finally {
      busyRef.current = false;
    }
  }

  async function handleArrival(layer: DataLayer, jobId: string, staffId: string) {
    const arrivalTime = new Date().toISOString();

    // The open-entry check stays a network read: it is an IDEMPOTENCE guard, and
    // treating "I could not check" as "there is none" would clock the technician
    // in twice. When it fails we skip the insert rather than risk a duplicate —
    // and the departure below still closes whatever is genuinely open.
    const { data: openEntry, error: openError } = await supabase
      .from("time_entries")
      .select("id")
      .eq("job_id", jobId)
      .eq("staff_id", staffId)
      .eq("entry_type", "work")
      .is("clock_out", null)
      .maybeSingle();

    // A failed check is NOT "no open entry" — see above. Skip rather than risk
    // clocking the technician in on top of an entry that already exists.
    if (openError) {
      console.warn("[geofence] could not check for an open entry; skipping clock-in:", openError.message);
      return;
    }

    if (!openEntry) {
      // THROUGH THE OUTBOX, not straight to Supabase.
      //
      // This used to be a direct insert, so a technician arriving somewhere with
      // no signal produced no row, no queued operation, no error and no sync
      // badge — the arrival was discarded and never re-derived after reconnect,
      // losing the visit's entire clock-in. The MANUAL clock button has always
      // been durable; the AUTOMATIC one, which fires precisely when nobody is
      // watching the screen, was not. clockIn() also enqueues the billing sync,
      // which the direct path did by hand.
      await layer.timeEntries.clockIn({ jobId, staffId });
    }

    const departure = departureRef.current;
    departureRef.current = null;
    if (departure) {
      const hours = plausibleAutoClockHours(departure.time, arrivalTime, MAX_PLAUSIBLE_TRAVEL_HOURS);
      if (hours !== null) {
        await layer.timeEntries.addManual({
          jobId,
          staffId,
          clockInIso: departure.time,
          clockOutIso: arrivalTime,
          entryType: "travel",
          costCenterId: null,
          travelFromJobId: departure.jobId,
          autoClocked: true,
        });
      }
    }
  }

  async function handleDeparture(layer: DataLayer, jobId: string, staffId: string) {
    const departTime = new Date().toISOString();

    const { data: openEntry } = await supabase
      .from("time_entries")
      .select("id, clock_in")
      .eq("job_id", jobId)
      .eq("staff_id", staffId)
      .eq("entry_type", "work")
      .is("clock_out", null)
      .maybeSingle();

    if (openEntry) {
      // Null when the duration cannot be believed — a backward clock correction
      // (which would otherwise write NEGATIVE hours and subtract from the
      // technician's pay) or a departure event that never fired, leaving the
      // entry open for days. The entry still CLOSES either way; leaving it open
      // is its own problem. The office then sees a gap to correct rather than a
      // number that quietly reconciles wrong.
      // Through the outbox, like the manual clock-out. A direct update meant a
      // departure with no signal simply never closed the entry — the technician
      // stayed clocked in, and the office saw an entry running for days.
      await layer.timeEntries.clockOut({ entryId: openEntry.id, clockInIso: openEntry.clock_in });
    }

    departureRef.current = { time: departTime, jobId };
  }

  return <LocationTrackingContext.Provider value={{ enabled: !!userId }}>{children}</LocationTrackingContext.Provider>;
}

export function useLocationTracking() {
  return useContext(LocationTrackingContext);
}
