// The geofence decision, as a pure function.
//
// This logic used to live inside LocationTrackingProvider, closed over three
// React refs. That made it unreachable in two directions: no test could call it,
// and neither could a BACKGROUND location task, which runs with no React tree.
// The consequence was not cosmetic — the auto-clock only worked while the app
// was open, so travel time on a backgrounded phone was silently never recorded.
// A payroll feature that under-records quietly is worse than one that is
// obviously absent, because nobody thinks to check it.
//
// Extracting it changes nothing about the behaviour; it just makes the same
// decision callable from both the foreground watcher and the background task,
// so the two cannot drift apart.

/** Mirrors the constant used by the web side (components/job/job-time.tsx). */
export const GEOFENCE_RADIUS_METERS = 150;

export interface TrackedSite {
  jobId: string;
  lat: number;
  lng: number;
}

export interface Coords {
  latitude: number;
  longitude: number;
}

export type GeofenceTransition = "arrival" | "departure" | "none";

export interface GeofenceState {
  /** The job whose site we are currently inside, or null. */
  insideJobId: string | null;
  /** Where we were before this reading — needed to attribute a travel leg. */
  previousJobId: string | null;
  transition: GeofenceTransition;
}

export function haversineDistance(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000;
  const toRad = (n: number) => (n * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Decide what this position reading means, given where we were.
 *
 * @param currentInsideJobId the job we were inside before this reading
 */
export function nextGeofenceState(
  coords: Coords,
  sites: TrackedSite[],
  currentInsideJobId: string | null,
  radiusMeters: number = GEOFENCE_RADIUS_METERS
): GeofenceState {
  // An empty site list means "not loaded yet", NOT "you have left every site".
  // Sites arrive asynchronously, and treating the gap as a departure would
  // fabricate a clock-out — and, worse, a travel entry attributed to it.
  if (sites.length === 0) {
    return { insideJobId: currentInsideJobId, previousJobId: currentInsideJobId, transition: "none" };
  }

  let nearestJobId: string | null = null;
  let nearestDist = Infinity;

  for (const site of sites) {
    // A site with no coordinates is not at (0, 0) — that is in the Atlantic, and
    // coercing it there would make the technician permanently "away" from it.
    if (typeof site.lat !== "number" || typeof site.lng !== "number") continue;
    if (!Number.isFinite(site.lat) || !Number.isFinite(site.lng)) continue;

    const d = haversineDistance(coords.latitude, coords.longitude, site.lat, site.lng);
    if (d < nearestDist) {
      nearestDist = d;
      nearestJobId = site.jobId;
    }
  }

  const insideJobId = nearestDist <= radiusMeters ? nearestJobId : null;

  if (insideJobId === currentInsideJobId) {
    return { insideJobId, previousJobId: currentInsideJobId, transition: "none" };
  }

  return {
    insideJobId,
    previousJobId: currentInsideJobId,
    // Moving straight from one site to another is an ARRIVAL, and previousJobId
    // carries the site we left so the travel leg can be attributed to it.
    transition: insideJobId ? "arrival" : "departure",
  };
}
