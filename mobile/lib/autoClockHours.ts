// Deciding whether an auto-clocked duration is believable.
//
// The geofence auto-clock writes time entries with no human in the loop: it
// clocks a technician in on arrival at a site and out on departure, and those
// hours reach payroll. Nothing reviews them, so a wrong number is not obviously
// wrong to anyone until a pay run.
//
// Two silent failure modes in the field:
//
//   - The phone corrects its clock between arrival and departure (NTP pulling a
//     fast handset back, a timezone offset picked up on the road). clock_out
//     then precedes clock_in, and the subtraction yields NEGATIVE hours — which
//     SUBTRACTS from what the technician is paid.
//
//   - The departure event never fires: app killed, location permission revoked,
//     battery flat. The entry stays open until the technician next returns to
//     that site, which may be days.
//
// The travel path already guarded against this; the work path did not, and wrote
// whatever the subtraction produced.
//
// `time_entries.hours` is nullable in production (verified against the live
// schema), so an implausible duration is recorded as NULL. The entry still
// closes — leaving it open is its own problem — and the office sees a gap to
// correct rather than a number that quietly reconciles wrong.

/** A technician moving between two sites. Beyond this it is not travel. */
export const MAX_PLAUSIBLE_TRAVEL_HOURS = 3;

/**
 * A single unbroken stint on one site. Deliberately generous — long emergency
 * call-outs happen, and refusing a real shift is worse than accepting a slightly
 * odd one, because a refused shift is invisible while an odd one gets queried.
 * Its job is to catch a missed departure, not to police overtime.
 */
export const MAX_PLAUSIBLE_WORK_HOURS = 16;

/**
 * Hours between two ISO timestamps, rounded to 2dp — or null when the duration
 * cannot be believed.
 *
 * Null means "close the entry, record no hours", never "silently write
 * something wrong". Mirrors the rounding of the manual path
 * (repositories/timeEntries.ts hoursBetween) so an auto-clocked entry and a
 * hand-entered one agree.
 */
export function plausibleAutoClockHours(
  startIso: string,
  endIso: string,
  maxHours: number
): number | null {
  const start = new Date(startIso).getTime();
  const end = new Date(endIso).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;

  const hours = Math.round(((end - start) / 3600000) * 100) / 100;
  if (hours <= 0) return null; // clock moved backwards, or a zero-length entry
  if (hours > maxHours) return null; // a missed departure, not a real shift
  return hours;
}
