// The trip a "Work out km" button measures, and how its answer reads
// (27 Nov 2026). Used by the web Day Works tab; mirrored byte for byte from
// the first export at mobile/lib/distanceTrip.ts
// (tests/unit/distance-trip-mirror.test.ts) — change this file first.
// The lookup itself is GET/POST /api/distance (lib/distance.ts). No money.

export interface TripEnds {
  from: string;
  to: string;
}

/** What the server answered (no money: places and km only). */
export interface DistanceResult {
  km: number;
  from: { label: string; precise: boolean };
  to: { label: string; precise: boolean };
  approximate: boolean;
}

/** The word the distance route reads as "this job's site" (its pin, else its address). */
export const JOB_SITE = "site";

/**
 * A float move or cartage-by-km line: pick-up → drop-off as typed. An empty
 * end is the job's site (floats usually go to or from it); both empty → ask.
 */
export function floatTripEnds(pickup: string, dropoff: string): TripEnds | { error: string } {
  const from = pickup.trim();
  const to = dropoff.trim();
  if (!from && !to) return { error: "Type where it was picked up and where it went first." };
  return { from: from || JOB_SITE, to: to || JOB_SITE };
}

/**
 * A truck load, from → to as the form defines them: the From / To boxes when
 * typed; otherwise material in = the quarry → the job site, spoil out = the
 * job site → the tip.
 */
export function truckLoadTripEnds(load: {
  direction: "material_in" | "spoil_out";
  place: string;
  from_text: string;
  to_text: string;
}): TripEnds | { error: string } {
  const place = load.place.trim();
  const from = load.from_text.trim() || (load.direction === "material_in" ? place : JOB_SITE);
  const to = load.to_text.trim() || (load.direction === "spoil_out" ? place : JOB_SITE);
  if (!from) return { error: "Pick the quarry (or type where it came from) first." };
  if (!to) return { error: "Type the tip (or where it went) first." };
  return { from, to };
}

/** "≈ 23.4 km by road from Boral Wollert to 12 Smith St" (+ approximate). */
export function distanceNote(r: DistanceResult): string {
  const base = `≈ ${r.km} km by road from ${r.from.label} to ${r.to.label}`;
  return r.approximate ? `${base} — approximate: a place was only matched to its street or suburb, check it` : base;
}

/** The km box's text for an answer: "23.4", "18". */
export function kmFieldText(km: number): string {
  return String(Math.round(km * 10) / 10);
}
