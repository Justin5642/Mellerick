import { metresBetween } from "@/lib/clock-location";

// A site's pin from where the crew clocked on (2 Nov 2026). The free geocoder
// can't place most new-estate lots ("Lot 2012, 81 Whiteside Street,
// Beveridge") or many established addresses, and a job with no pin can never
// auto-clock. But the crew stand on the lot: their first hand clock-on there
// records the phone's position (0092). The hourly /api/sites/geocode-missing
// turns that into the site's pin, so from the next day the job auto-clocks.
//
// The risk is a clock-on made somewhere else — at the yard, or on the drive
// in — pinning the fence to the wrong place, which would then clock people
// onto the job wherever that was. So a reading only counts when it is:
//   - accurate (±50 m, the same bar as "Set site location here"), and
//   - within 3 km of the street or suburb the geocoder CAN find, or, when it
//     can't find even that, confirmed by a second clock-on (another day or
//     another person) within 100 m.

export const MAX_READING_ACCURACY_M = 50;
export const MAX_FROM_STREET_M = 3_000;
export const AGREE_WITHIN_M = 100;

export interface ClockOnReading {
  staffId: string;
  clockIn: string;
  lat: number;
  lng: number;
  accuracy: number | null;
}

export interface SitePin {
  lat: number;
  lng: number;
  staffId: string;
}

/** The pin these clock-ons give, or null when they don't give a safe one. */
export function pinFromClockOns(readings: ClockOnReading[], nearby: { lat: number; lng: number } | null): SitePin | null {
  const usable = readings
    .filter((r) => Number.isFinite(r.lat) && Number.isFinite(r.lng) && !(r.lat === 0 && r.lng === 0))
    .filter((r) => r.accuracy != null && r.accuracy <= MAX_READING_ACCURACY_M)
    .sort((a, b) => (a.accuracy ?? Infinity) - (b.accuracy ?? Infinity));

  if (nearby) {
    const best = usable.find((r) => metresBetween(r.lat, r.lng, nearby.lat, nearby.lng) <= MAX_FROM_STREET_M);
    return best ? { lat: best.lat, lng: best.lng, staffId: best.staffId } : null;
  }

  // Nothing to check against: two independent clock-ons must agree.
  for (const a of usable) {
    const agrees = usable.some(
      (b) =>
        b !== a &&
        (b.staffId !== a.staffId || b.clockIn.slice(0, 10) !== a.clockIn.slice(0, 10)) &&
        metresBetween(a.lat, a.lng, b.lat, b.lng) <= AGREE_WITHIN_M
    );
    if (agrees) return { lat: a.lat, lng: a.lng, staffId: a.staffId };
  }
  return null;
}
