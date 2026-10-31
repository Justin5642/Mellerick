import * as Location from "expo-location";

// Where the phone was when a clock-on or clock-off was written (migration
// 0092, DRAFT, not applied yet). Recorded, never enforced: the office sees how
// far from the site it was, and anything outside the fence is flagged on the
// web Time tab. A clock write never waits long for it and never fails for
// want of it.

export interface ClockFix {
  lat: number;
  lng: number;
  /** Metres; null when the OS didn't say. */
  accuracy: number | null;
}

/** A fix from coordinates the caller already has (a geofence reading). */
export function fixFromCoords(c: { latitude: number; longitude: number; accuracy?: number | null } | null | undefined): ClockFix | null {
  if (!c || !Number.isFinite(c.latitude) || !Number.isFinite(c.longitude)) return null;
  return { lat: c.latitude, lng: c.longitude, accuracy: typeof c.accuracy === "number" && Number.isFinite(c.accuracy) ? Math.round(c.accuracy) : null };
}

/** The row columns for a fix, prefixed clock_in_ or clock_out_. Empty with no fix. */
export function fixColumns(prefix: "clock_in" | "clock_out", fix: ClockFix | null | undefined): Record<string, number | null> {
  if (!fix) return {};
  return { [`${prefix}_lat`]: fix.lat, [`${prefix}_lng`]: fix.lng, [`${prefix}_accuracy`]: fix.accuracy };
}

/**
 * The phone's position now, for a manual clock-on/off. Only when location is
 * already allowed (never prompts), a recent fix first, and at most `timeoutMs`
 * for a fresh one. Null rather than a throw on any failure.
 */
export async function currentFix(timeoutMs = 4000): Promise<ClockFix | null> {
  try {
    const perm = await Location.getForegroundPermissionsAsync();
    if (perm.status !== "granted") return null;
    const recent = await Location.getLastKnownPositionAsync({ maxAge: 60_000, requiredAccuracy: 100 });
    if (recent) return fixFromCoords(recent.coords);
    const fresh = await Promise.race([
      Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
    ]);
    return fresh ? fixFromCoords(fresh.coords) : null;
  } catch {
    return null;
  }
}
