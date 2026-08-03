import { createContext, useContext, useEffect, useRef, type ReactNode } from "react";
import * as Location from "expo-location";
import { supabase } from "./supabase";
import { useAuth } from "./auth-context";
import { plausibleAutoClockHours, MAX_PLAUSIBLE_TRAVEL_HOURS, MAX_PLAUSIBLE_WORK_HOURS } from "./autoClockHours";
import { nextGeofenceState, type TrackedSite } from "./geofenceState";

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
 * IMPORTANT — foreground only: this uses expo-location's foreground
 * watchPositionAsync, which only runs while the app is open (active or
 * backgrounded briefly by the OS — not force-quit). True background
 * tracking (app fully closed) needs expo-task-manager + background
 * location permissions, which Expo Go does not support (especially on
 * iOS) — that requires a custom dev client / EAS build. This is the
 * pragmatic v1 that works today in Expo Go: as long as a tech has the
 * app open (which they will, to see job details/photos/etc while working),
 * clock in/out and travel time are captured automatically.
 */
export function LocationTrackingProvider({ children }: { children: ReactNode }) {
  const { session } = useAuth();
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
    })();

    return () => {
      cancelled = true;
      subscription?.remove();
    };
  }, [userId]);

  async function handlePosition(position: Location.LocationObject, staffId: string) {
    if (busyRef.current) return;
    const sites = sitesRef.current;
    if (sites.length === 0) return;

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
        await handleArrival(insideJobId, staffId);
      } else if (previousJobId) {
        await handleDeparture(previousJobId, staffId);
      }
    } finally {
      busyRef.current = false;
    }
  }

  async function handleArrival(jobId: string, staffId: string) {
    const arrivalTime = new Date().toISOString();

    const { data: openEntry } = await supabase
      .from("time_entries")
      .select("id")
      .eq("job_id", jobId)
      .eq("staff_id", staffId)
      .eq("entry_type", "work")
      .is("clock_out", null)
      .maybeSingle();

    if (!openEntry) {
      const { data } = await supabase
        .from("time_entries")
        .insert({
          job_id: jobId,
          staff_id: staffId,
          clock_in: arrivalTime,
          auto_clocked: true,
          entry_type: "work",
        })
        .select("id")
        .single();
      if (data) syncBilling(data.id);
    }

    const departure = departureRef.current;
    departureRef.current = null;
    if (departure) {
      const hours = plausibleAutoClockHours(departure.time, arrivalTime, MAX_PLAUSIBLE_TRAVEL_HOURS);
      if (hours !== null) {
        await supabase.from("time_entries").insert({
          job_id: jobId,
          staff_id: staffId,
          clock_in: departure.time,
          clock_out: arrivalTime,
          hours,
          entry_type: "travel",
          travel_from_job_id: departure.jobId,
          auto_clocked: true,
        });
      }
    }
  }

  async function handleDeparture(jobId: string, staffId: string) {
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
      const hours = plausibleAutoClockHours(openEntry.clock_in, departTime, MAX_PLAUSIBLE_WORK_HOURS);
      await supabase.from("time_entries").update({ clock_out: departTime, hours }).eq("id", openEntry.id);
      syncBilling(openEntry.id);
    }

    departureRef.current = { time: departTime, jobId };
  }

  return <LocationTrackingContext.Provider value={{ enabled: !!userId }}>{children}</LocationTrackingContext.Provider>;
}

export function useLocationTracking() {
  return useContext(LocationTrackingContext);
}
