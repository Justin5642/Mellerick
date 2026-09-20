// Pure scheduling rules for the "Schedule Job" flow (job detail header, both
// web and mobile). No I/O here — reads and writes stay in each platform's own
// data layer (lib/schedule-dispatch.ts on web, ScheduleRepository on mobile);
// mirrored byte-identical at ../lib/scheduling.ts so both platforms make the
// same call about defaults and validity.
import { fromBusinessInputValue, shiftDateKey } from "./date";

// The standard field shift a single job fills when it's the only job a
// technician has that day (job-overview's quick-fill button and the
// Schedule Job flow's "All day" toggle both resolve to this).
export const DEFAULT_SHIFT_START_TIME = "07:00";
export const DEFAULT_SHIFT_END_TIME = "15:30";

/**
 * Whether "All day" should default ON for a technician on a given day.
 * ON when this would be their only job that day (one job filling the
 * standard shift); OFF once they already have another, so the office sets a
 * custom time block per job instead of stamping every job on a busy day with
 * the same 7:00-3:30.
 */
export function defaultAllDay(otherJobsForTechOnDay: number): boolean {
  return otherJobsForTechOnDay === 0;
}

/** The standard shift's start/end for a "YYYY-MM-DD" business date, as stored UTC ISO instants. */
export function standardShiftFor(dateKey: string): { scheduledStartIso: string; scheduledEndIso: string } {
  return {
    scheduledStartIso: fromBusinessInputValue(`${dateKey}T${DEFAULT_SHIFT_START_TIME}`),
    scheduledEndIso: fromBusinessInputValue(`${dateKey}T${DEFAULT_SHIFT_END_TIME}`),
  };
}

/** UTC ISO bounds [dayStartIso, dayEndIso) for a "YYYY-MM-DD" business date — for a `scheduled_start` range query. */
export function businessDayRange(dateKey: string): { dayStartIso: string; dayEndIso: string } {
  return {
    dayStartIso: fromBusinessInputValue(`${dateKey}T00:00`),
    dayEndIso: fromBusinessInputValue(`${shiftDateKey(dateKey, 1)}T00:00`),
  };
}

/** Null when the window is valid, otherwise a message to show the user. */
export function validateScheduleWindow(scheduledStartIso: string, scheduledEndIso: string): string | null {
  if (new Date(scheduledEndIso).getTime() <= new Date(scheduledStartIso).getTime()) {
    return "End time must be after the start time.";
  }
  return null;
}
