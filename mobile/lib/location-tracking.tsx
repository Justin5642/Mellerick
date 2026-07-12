import { createContext, useContext, useEffect, useRef, type ReactNode } from "react";
import * as Location from "expo-location";
import { supabase } from "./supabase";
import { useAuth } from "./auth-context";

// Mirrors the constant used on the web side (components/job/job-time.tsx)
// so a tech is treated as "on site" consistently across platforms.
const GEOFENCE_RADIUS_METERS = 150;

// If the gap between leaving one job's fence and arriving at another's is
// longer than this, we don't log it as travel — most likely the app was
// backgrounded/killed for a while (lunch break, end of day, etc.) rather
// than genuine drive time between two jobs.
const MAX_PLAUSIBLE_TRAVEL_HOURS = 3;

interface TrackedSite {
  jobId: string;
  lat: number;
  lng: number;
}

function haversineDistance(lat1: number, lng1: number, lat2: number, lng2: number) {
  const R = 6371000;
  const toRad = (n: number) => (n * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
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
      const { data } = await supabase
        .from("jobs")
        .select("id, status, sites(site_lat, site_lng)")
        .eq("assigned_to", userId)
        .not("status", "in", '("completed","cancelled")');
      if (cancelled) return;
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

    let nearestJobId: string | null = null;
    let nearestDist = Infinity;
    for (const site of sites) {
      const d = haversineDistance(position.coords.latitude, position.coords.longitude, site.lat, site.lng);
      if (d < nearestDist) {
        nearestDist = d;
        nearestJobId = site.jobId;
      }
    }
    const insideJobId = nearestDist <= GEOFENCE_RADIUS_METERS ? nearestJobId : null;
    if (insideJobId === insideJobIdRef.current) return;

    const previousJobId = insideJobIdRef.current;
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
      await supabase.from("time_entries").insert({
        job_id: jobId,
        staff_id: staffId,
        clock_in: arrivalTime,
        auto_clocked: true,
        entry_type: "work",
      });
    }

    const departure = departureRef.current;
    departureRef.current = null;
    if (departure) {
      const hours = Math.round(((new Date(arrivalTime).getTime() - new Date(departure.time).getTime()) / 3600000) * 100) / 100;
      if (hours > 0 && hours <= MAX_PLAUSIBLE_TRAVEL_HOURS) {
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
      const hours = Math.round(((new Date(departTime).getTime() - new Date(openEntry.clock_in).getTime()) / 3600000) * 100) / 100;
      await supabase.from("time_entries").update({ clock_out: departTime, hours }).eq("id", openEntry.id);
    }

    departureRef.current = { time: departTime, jobId };
  }

  return <LocationTrackingContext.Provider value={{ enabled: !!userId }}>{children}</LocationTrackingContext.Provider>;
}

export function useLocationTracking() {
  return useContext(LocationTrackingContext);
}
