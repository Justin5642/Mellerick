// Deciding whether a clocked duration is believable, before it reaches payroll.
//
// The web clock-in/out previously did the subtraction inline and wrote whatever
// came out straight to `time_entries.hours`, in two places. Nothing checked the
// sign or the magnitude.
//
// The scenario that makes that more than theoretical is CROSS-DEVICE. A
// technician clocks in on the mobile app whose device clock runs fast; the
// office clocks them out from the web with a correct clock. `clock_out` then
// precedes `clock_in`, the subtraction goes negative, and a negative number is
// written to the row that feeds payroll — SUBTRACTING from what the technician
// is paid. Nothing raises; it simply reconciles wrong at the next pay run.
//
// The same defect existed in the mobile geofence auto-clock and is fixed there
// in mobile/lib/autoClockHours.ts. This is the web half. The two are deliberately
// kept in step: a technician clocking in on the phone and out on the web must
// not get a different verdict on the same duration.
//
// `time_entries.hours` is nullable in production (verified against the live
// schema, not assumed), so an implausible duration is recorded as NULL. The
// entry still closes — leaving it open is its own problem — and the office sees
// a gap to correct rather than a figure that looks legitimate.

/**
 * A single unbroken stint on one site. Deliberately generous: long emergency
 * call-outs are real, and refusing a genuine shift is worse than accepting an
 * odd one, because a refused shift is invisible while an odd one gets queried.
 * Its job is to catch a stuck entry or a skewed clock, not to police overtime.
 *
 * Must match MAX_PLAUSIBLE_WORK_HOURS in mobile/lib/autoClockHours.ts.
 */
export const MAX_PLAUSIBLE_WORK_HOURS = 16;

/**
 * Hours between two ISO timestamps rounded to 2dp, or null when the duration
 * cannot be believed.
 *
 * Null means "close the entry, record no hours" — never "write something wrong
 * and hope someone notices".
 */
export function plausibleClockedHours(clockIn: string, clockOut: string): number | null {
  const start = new Date(clockIn).getTime();
  const end = new Date(clockOut).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;

  const hours = Math.round(((end - start) / 3600000) * 100) / 100;
  if (hours <= 0) return null; // clock skew across devices, or a zero-length entry
  if (hours > MAX_PLAUSIBLE_WORK_HOURS) return null; // an entry left open, not a shift
  return hours;
}
