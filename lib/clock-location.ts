// How far from the site a clock-on or clock-off was (migration 0092, DRAFT,
// not applied yet). The phone records where it was; this is how the web Time
// tab reads it for the office. Nothing is blocked by it — it is a flag.

/** The site fence, as the phone's auto-clock uses it (mobile/lib/geofenceState.ts). */
export const SITE_FENCE_METRES = 150;

export function metresBetween(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000;
  const toRad = (n: number) => (n * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export interface ClockPlace {
  /** Rounded metres from the site's pin. */
  metres: number;
  /** Outside the fence even allowing for the phone's stated accuracy. */
  outside: boolean;
  label: string;
}

/**
 * Where a clock-on/off was relative to the site. Null when the phone recorded
 * no position or the site has no pin — there is nothing to say.
 */
export function clockPlace(
  at: { lat: number | null | undefined; lng: number | null | undefined; accuracy?: number | null },
  site: { lat: number | null | undefined; lng: number | null | undefined } | null | undefined
): ClockPlace | null {
  if (at.lat == null || at.lng == null || !site || site.lat == null || site.lng == null) return null;
  if (!site.lat || !site.lng) return null; // 0/0 is an unset pin, not a place
  const metres = Math.round(metresBetween(Number(at.lat), Number(at.lng), Number(site.lat), Number(site.lng)));
  const slack = typeof at.accuracy === "number" ? at.accuracy : 0;
  const outside = metres - slack > SITE_FENCE_METRES;
  const distance = metres < 1000 ? `${metres} m` : `${(metres / 1000).toFixed(1)} km`;
  return { metres, outside, label: outside ? `${distance} from site` : metres <= 50 ? "on site" : `${distance} from site` };
}
