import { officeApi } from "./officeApi";
import type { DistanceResult, TripEnds } from "./distanceTrip";

// "Work out km" on the phone (27 Nov 2026): one online call to the web's
// /api/distance (OSRM road distance + Nominatim places, no key). Any staff
// role may use it. Online only — offline officeApi says it needs signal. The
// km box always stays editable. No money.

export async function lookupDistance(jobId: string, ends: TripEnds): Promise<DistanceResult> {
  return officeApi<DistanceResult>("/api/distance", { method: "POST", body: { from: ends.from, to: ends.to, jobId } });
}

/**
 * Fill the km box only if it still holds what it held when the button was
 * pressed — a value typed while the lookup ran is never overwritten.
 */
export function shouldFillKm(kmAtPress: string, kmNow: string): boolean {
  return kmAtPress === kmNow;
}
