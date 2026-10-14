// Pure scheduling rules for the "Schedule Job" flow (job detail header, both
// web and mobile). No I/O here — reads and writes stay in each platform's own
// data layer (lib/schedule-dispatch.ts on web, ScheduleRepository on mobile);
// mirrored byte-identical at ../lib/scheduling.ts so both platforms make the
// same call about defaults and validity.
import {
  dateKeyInBusinessTZ,
  fromBusinessInputValue,
  shiftDateKey,
  toBusinessInputValue,
  withDateKeyPreservingTime,
} from "./date";

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

// ---------------------------------------------------------------------------
// Multi-day schedules (migration 0071)
// ---------------------------------------------------------------------------
// A job still stores ONE window, scheduled_start..scheduled_end. What that
// window MEANS depends on jobs.schedule_daily:
//
//   false (every job before 0071) — one continuous block, as it always was.
//   true  — the same hours on each WORKDAY from the start date to the end
//           date: scheduled_start carries the first day and the daily start
//           time, scheduled_end the last day and the daily end time. A Mon–Wed
//           all-day job is 7:00–15:30 on Mon, Tue and Wed — three 8.5 h
//           blocks (8 h + the 30 min break), not one 56.5 h block.
//
// Saturdays and Sundays INSIDE a multi-day range are skipped (office's call,
// 14 Oct 2026). A start or end date that itself falls on a weekend is booked —
// it was picked deliberately — so a one-off Saturday job, a Sat–Sun job, or a
// job pasted onto a Saturday all keep that day.
//
// jobs.schedule_all_day only remembers that "All day" was ticked, so the
// dialog reopens the way it was saved; the times themselves are the source
// of truth.
//
// Every reader that asks "is this job on day X?" or "how many hours is this
// tech booked?" must go through scheduleDays()/occupiesDay() rather than
// bucketing on scheduled_start — that is what showed a multi-day job on its
// first day only.

export interface ScheduledJobWindow {
  scheduled_start: string | null;
  scheduled_end: string | null;
  schedule_daily?: boolean | null;
}

export interface ScheduleDay {
  /** Melbourne "YYYY-MM-DD". */
  dateKey: string;
  startIso: string;
  endIso: string;
}

/** 0 = Sunday … 6 = Saturday, for a Melbourne "YYYY-MM-DD" key (UTC-noon anchor never crosses a date line). */
export function dayOfWeekForDateKey(dateKey: string): number {
  const [y, m, d] = dateKey.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12, 0, 0)).getUTCDay();
}

export function isWeekendDateKey(dateKey: string): boolean {
  const dow = dayOfWeekForDateKey(dateKey);
  return dow === 0 || dow === 6;
}

/** Hard stop on how long one schedule may run, so a typo'd year cannot build a 100k-day list. */
export const MAX_SCHEDULE_DAYS = 366;

/**
 * The booked days from startKey to endKey inclusive: the two endpoints, plus
 * every weekday between them. [] when end < start.
 */
export function workdayKeysBetween(startKey: string, endKey: string): string[] {
  if (endKey < startKey) return [];
  const days: string[] = [];
  let scanned = 0;
  for (let key = startKey; key <= endKey && scanned < MAX_SCHEDULE_DAYS; key = shiftDateKey(key, 1), scanned++) {
    if (key === startKey || key === endKey || !isWeekendDateKey(key)) days.push(key);
  }
  return days;
}

function timeOfDay(iso: string): string {
  return toBusinessInputValue(iso).slice(11, 16);
}

/** The concrete blocks a job occupies, one per booked day. [] when unscheduled. */
export function scheduleDays(job: ScheduledJobWindow): ScheduleDay[] {
  if (!job.scheduled_start) return [];
  const start = job.scheduled_start;
  // A start with no end is a one-hour placeholder everywhere else (calendar
  // push), so it occupies its start day only.
  const end = job.scheduled_end ?? start;
  if (!job.schedule_daily) {
    return [{ dateKey: dateKeyInBusinessTZ(start), startIso: start, endIso: end }];
  }
  const startTime = timeOfDay(start);
  const endTime = timeOfDay(end);
  return workdayKeysBetween(dateKeyInBusinessTZ(start), dateKeyInBusinessTZ(end)).map((dateKey) => ({
    dateKey,
    startIso: fromBusinessInputValue(`${dateKey}T${startTime}`),
    endIso: fromBusinessInputValue(`${dateKey}T${endTime}`),
  }));
}

/** Whether the job is booked on the given Melbourne "YYYY-MM-DD" day. */
export function occupiesDay(job: ScheduledJobWindow, dateKey: string): boolean {
  return scheduleDays(job).some((d) => d.dateKey === dateKey);
}

/** Booked hours on one day (0 when not booked that day). */
export function scheduledHoursOnDay(job: ScheduledJobWindow, dateKey: string): number {
  const day = scheduleDays(job).find((d) => d.dateKey === dateKey);
  if (!day) return 0;
  return Math.max(0, (new Date(day.endIso).getTime() - new Date(day.startIso).getTime()) / 3_600_000);
}

/** Total booked hours across every day. */
export function totalScheduledHours(job: ScheduledJobWindow): number {
  return scheduleDays(job).reduce(
    (sum, d) => sum + Math.max(0, (new Date(d.endIso).getTime() - new Date(d.startIso).getTime()) / 3_600_000),
    0,
  );
}

/**
 * The [firstDayStart, lastDayEnd) span a job can touch — for a database
 * overlap query (`scheduled_start < rangeEnd AND scheduled_end > rangeStart`)
 * whose rows are then narrowed with occupiesDay().
 */
export function scheduleSpan(job: ScheduledJobWindow): { startIso: string; endIso: string } | null {
  const days = scheduleDays(job);
  if (days.length === 0) return null;
  return { startIso: days[0].startIso, endIso: days[days.length - 1].endIso };
}

export interface ScheduleInput {
  startDateKey: string;
  /** Same as startDateKey for a single-day job. */
  endDateKey: string;
  /** "HH:mm" — ignored when allDay. */
  startTime: string;
  endTime: string;
  allDay: boolean;
}

export interface ScheduleColumns {
  scheduled_start: string;
  scheduled_end: string;
  schedule_daily: boolean;
  schedule_all_day: boolean;
}

/** Null when valid, otherwise a message to show the user. */
export function validateScheduleInput(input: ScheduleInput): string | null {
  if (!input.startDateKey) return "Pick a start date.";
  if (!input.endDateKey || input.endDateKey < input.startDateKey) return "The end date can't be before the start date.";
  const startTime = input.allDay ? DEFAULT_SHIFT_START_TIME : input.startTime;
  const endTime = input.allDay ? DEFAULT_SHIFT_END_TIME : input.endTime;
  if (!startTime || !endTime) return "Pick a start and end time.";
  // Multi-day jobs repeat the same hours each day, so the end time must be
  // after the start time even though the end DATE is later.
  if (endTime <= startTime) return "End time must be after the start time.";
  if (shiftDateKey(input.startDateKey, MAX_SCHEDULE_DAYS) <= input.endDateKey) {
    return `A schedule can't run longer than ${MAX_SCHEDULE_DAYS} days.`;
  }
  return null;
}

/** The jobs columns to write for a schedule. Call validateScheduleInput first. */
export function buildScheduleColumns(input: ScheduleInput): ScheduleColumns {
  const startTime = input.allDay ? DEFAULT_SHIFT_START_TIME : input.startTime;
  const endTime = input.allDay ? DEFAULT_SHIFT_END_TIME : input.endTime;
  return {
    scheduled_start: fromBusinessInputValue(`${input.startDateKey}T${startTime}`),
    scheduled_end: fromBusinessInputValue(`${input.endDateKey}T${endTime}`),
    schedule_daily: input.endDateKey !== input.startDateKey,
    schedule_all_day: input.allDay,
  };
}

/** A saved job's schedule as dialog inputs (the reverse of buildScheduleColumns). */
export function scheduleInputFromJob(
  job: ScheduledJobWindow & { schedule_all_day?: boolean | null },
): ScheduleInput | null {
  if (!job.scheduled_start) return null;
  const end = job.scheduled_end ?? job.scheduled_start;
  return {
    startDateKey: dateKeyInBusinessTZ(job.scheduled_start),
    // A legacy continuous block that crosses midnight stays a single-day
    // entry: its end date is not a "last day".
    endDateKey: job.schedule_daily ? dateKeyInBusinessTZ(end) : dateKeyInBusinessTZ(job.scheduled_start),
    startTime: timeOfDay(job.scheduled_start),
    endTime: timeOfDay(end),
    allDay: !!job.schedule_all_day,
  };
}

/**
 * Move a schedule so it starts on newStartKey, keeping its shape: a daily job
 * keeps its daily hours and its NUMBER OF BOOKED DAYS (a Mon–Wed job pasted on
 * a Thursday becomes Thu, Fri, Mon); a continuous block keeps its time of day
 * and duration.
 */
export function moveSchedule(
  job: ScheduledJobWindow,
  newStartKey: string,
): { scheduled_start: string; scheduled_end: string } | null {
  if (!job.scheduled_start) return null;
  const start = job.scheduled_start;
  const end = job.scheduled_end ?? start;
  if (!job.schedule_daily) {
    const newStart = withDateKeyPreservingTime(start, newStartKey);
    const duration = new Date(end).getTime() - new Date(start).getTime();
    return { scheduled_start: newStart, scheduled_end: new Date(new Date(newStart).getTime() + duration).toISOString() };
  }
  const bookedDays = Math.max(1, scheduleDays(job).length);
  // The new start day is always booked (an endpoint — even on a weekend); the
  // remaining days land on weekdays.
  let lastKey = newStartKey;
  let counted = 1;
  while (counted < bookedDays) {
    lastKey = shiftDateKey(lastKey, 1);
    if (!isWeekendDateKey(lastKey)) counted++;
  }
  return {
    scheduled_start: withDateKeyPreservingTime(start, newStartKey),
    scheduled_end: withDateKeyPreservingTime(end, lastKey),
  };
}
