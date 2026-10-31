import { clockInCostCentre, type BookingWindow } from "./bookings";

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

/** Inside a site: within this distance of its coordinates. */
export const GEOFENCE_RADIUS_METERS = 150;

/**
 * Left a site: beyond THIS distance, not the arrival radius (Stage 5, 31 Oct
 * 2026). Phone fixes wander ±100 m under a house, in a trench beside a truck or
 * on a weak signal; with one radius for both, a single wandering reading
 * clocked a tech off and straight back on, splitting the day and inventing a
 * travel leg. The gap between 150 and 250 is the buffer.
 */
export const GEOFENCE_EXIT_RADIUS_METERS = 250;

/**
 * A reading less accurate than this is ignored. Balanced accuracy is ~100 m
 * at worst on a good day; a 500 m wifi-only or "Approximate location" fix
 * against a 150 m fence decides nothing and was being used as-is.
 */
export const MAX_READING_ACCURACY_METERS = 75;

export interface TrackedSite {
  jobId: string;
  lat: number;
  lng: number;
  /** The stage this job was scheduled against — new clock-ins at this site default to it. */
  scheduledCostCenterId: string | null;
  /**
   * This technician's own bookings on the job (0079), when known. An arrival defaults to the cost centre of the booking
   * covering it (lib/bookings.ts clockInCostCentre), falling back to
   * scheduledCostCenterId. Optional: a context published by an older build,
   * or a site list loaded before bookings exist, simply has none.
   */
  bookings?: BookingWindow[];
}

/** The cost centre an arrival at `site` at `atMs` clocks in against. */
export function arrivalCostCentre(site: TrackedSite | undefined, atMs: number): string | null {
  if (!site) return null;
  return clockInCostCentre(site.bookings, atMs, site.scheduledCostCenterId);
}

export interface Coords {
  latitude: number;
  longitude: number;
  /** The fix's accuracy radius in metres, as expo-location reports it. Unknown = trusted. */
  accuracy?: number | null;
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

  // Too vague to decide anything: keep whatever we had.
  if (typeof coords.accuracy === "number" && Number.isFinite(coords.accuracy) && coords.accuracy > MAX_READING_ACCURACY_METERS) {
    return { insideJobId: currentInsideJobId, previousJobId: currentInsideJobId, transition: "none" };
  }

  // Still on the site we were on, by the wider exit radius — unless the reading
  // is properly inside a DIFFERENT site and nearer to it (two jobs side by
  // side on an estate), which is a move from one to the other.
  const current = currentInsideJobId ? sites.find((s) => s.jobId === currentInsideJobId) : undefined;
  if (current && Number.isFinite(current.lat) && Number.isFinite(current.lng)) {
    const dCurrent = haversineDistance(coords.latitude, coords.longitude, current.lat, current.lng);
    const movedNext = nearestJobId !== currentInsideJobId && nearestDist <= radiusMeters && nearestDist < dCurrent;
    if (dCurrent <= GEOFENCE_EXIT_RADIUS_METERS && !movedNext) {
      return { insideJobId: currentInsideJobId, previousJobId: currentInsideJobId, transition: "none" };
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
