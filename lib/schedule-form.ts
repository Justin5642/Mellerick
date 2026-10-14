// Web-only helpers shared by the three places a person types a schedule —
// the Schedule Job wizard, the job Overview form and New Job — and by the
// pages that list jobs by day. The day rules themselves (which days a job
// occupies, what the four columns mean) live in lib/scheduling.ts, which is
// mirrored byte-identical on mobile; this file only turns those rules into
// form state, query filters and display strings, so it is not mirrored.
import {
  DEFAULT_SHIFT_END_TIME,
  DEFAULT_SHIFT_START_TIME,
  buildScheduleColumns,
  isWeekendDateKey,
  occupiesDay,
  scheduleDays,
  scheduleInputFromJob,
  totalScheduledHours,
  validateScheduleInput,
  type ScheduleColumns,
  type ScheduleDay,
  type ScheduleInput,
  type ScheduledJobWindow,
} from "./scheduling";
import { anchorForDateKey, formatDate, toBusinessInputValue } from "./date";

/** What a cleared schedule writes. The flags go back to false with the times, so a later re-schedule starts clean. */
export const CLEARED_SCHEDULE = {
  scheduled_start: null,
  scheduled_end: null,
  schedule_daily: false,
  schedule_all_day: false,
} as const;

export type ScheduleColumnsOrCleared = ScheduleColumns | typeof CLEARED_SCHEDULE;

/** A blank form: no date picked, the standard shift in the time boxes, All day off. */
export function emptyScheduleInput(): ScheduleInput {
  return { startDateKey: "", endDateKey: "", startTime: DEFAULT_SHIFT_START_TIME, endTime: DEFAULT_SHIFT_END_TIME, allDay: false };
}

/** The form a saved job opens with — blank when it is not scheduled. */
export function scheduleFormFromJob(
  job: ScheduledJobWindow & { schedule_all_day?: boolean | null },
): ScheduleInput {
  return scheduleInputFromJob(job) ?? emptyScheduleInput();
}

/**
 * Change the start date. The end date follows it when the job was a single
 * day (end == old start, or no end yet) and when the new start would land
 * after the end; a deliberately longer range otherwise keeps its end.
 */
export function withStartDate(input: ScheduleInput, startDateKey: string): ScheduleInput {
  const followed =
    !input.endDateKey || input.endDateKey === input.startDateKey || (!!startDateKey && input.endDateKey < startDateKey);
  return { ...input, startDateKey, endDateKey: followed ? startDateKey : input.endDateKey };
}

/**
 * The columns a form writes. `optional` forms (Overview, New Job) treat a
 * blank start date as "not scheduled" and clear all four; the wizard always
 * needs a date.
 */
export function scheduleColumnsFromForm(
  input: ScheduleInput,
  { optional }: { optional: boolean },
): { ok: true; columns: ScheduleColumnsOrCleared } | { ok: false; error: string } {
  if (optional && !input.startDateKey) return { ok: true, columns: CLEARED_SCHEDULE };
  const error = validateScheduleInput({ ...input, endDateKey: input.endDateKey || input.startDateKey });
  if (error) return { ok: false, error };
  return { ok: true, columns: buildScheduleColumns({ ...input, endDateKey: input.endDateKey || input.startDateKey }) };
}

/** Whether two forms would write the same schedule (Overview only rewrites the schedule when it changed). */
export function sameScheduleInput(a: ScheduleInput, b: ScheduleInput): boolean {
  if (a.startDateKey !== b.startDateKey) return false;
  if (!a.startDateKey) return true; // both unscheduled
  if ((a.endDateKey || a.startDateKey) !== (b.endDateKey || b.startDateKey) || a.allDay !== b.allDay) return false;
  // All day ignores the typed times, so they do not count as a change.
  return a.allDay || (a.startTime === b.startTime && a.endTime === b.endTime);
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/**
 * PostgREST `or()` half of "this job can touch [rangeStart, …)": it ends after
 * rangeStart, or it has no end and starts inside the range. Pair it with
 * `.lt("scheduled_start", rangeEnd)` for a bounded range, select
 * schedule_daily, then narrow the rows with occupiesDay() — the span of a
 * multi-day job also covers the weekend days it skips.
 */
export function scheduleOverlapOrFilter(rangeStartIso: string): string {
  return `scheduled_end.gt.${rangeStartIso},and(scheduled_end.is.null,scheduled_start.gte.${rangeStartIso})`;
}

export interface JobForConflictCount extends ScheduledJobWindow {
  id: string;
  assigned_to: string | null;
}

/**
 * How many OTHER jobs each technician already has on a day — feeds the
 * wizard's All-day default. A technician is on a job when they are in its
 * job_assignments OR are its assigned_to (HANDOVER §10 trap 10: assigned_to is
 * only the crew's primary). Each job counts once per technician, and only when
 * it occupies the day, not merely when its span crosses it.
 */
export function countTechnicianJobsOnDay(
  jobs: JobForConflictCount[],
  assignments: { job_id: string; staff_id: string }[],
  technicianIds: string[],
  dateKey: string,
): Record<string, number> {
  const wanted = new Set(technicianIds);
  const onDay = new Map(jobs.filter((j) => occupiesDay(j, dateKey)).map((j) => [j.id, j]));
  const pairs = new Set<string>();
  for (const job of onDay.values()) {
    if (job.assigned_to && wanted.has(job.assigned_to)) pairs.add(`${job.assigned_to}|${job.id}`);
  }
  for (const a of assignments) {
    if (onDay.has(a.job_id) && wanted.has(a.staff_id)) pairs.add(`${a.staff_id}|${a.job_id}`);
  }
  const counts: Record<string, number> = {};
  for (const pair of pairs) {
    const staffId = pair.split("|")[0];
    counts[staffId] = (counts[staffId] ?? 0) + 1;
  }
  return counts;
}

/** The job's block on `dateKey`, or null when it is not booked that day. */
export function scheduleDayOn(job: ScheduledJobWindow, dateKey: string): ScheduleDay | null {
  return scheduleDays(job).find((d) => d.dateKey === dateKey) ?? null;
}

/** The first booked day on or after `dateKey`, or null when every booked day is behind it. */
export function nextScheduleDay(job: ScheduledJobWindow, dateKey: string): ScheduleDay | null {
  return scheduleDays(job).find((d) => d.dateKey >= dateKey) ?? null;
}

// ---------------------------------------------------------------------------
// Display (business time zone throughout)
// ---------------------------------------------------------------------------

/** "07:00" -> "7:00" — the board and the office read 24-hour times. */
function shortTime(hhmm: string): string {
  return hhmm.replace(/^0(\d)/, "$1");
}

function dayParts(dateKey: string) {
  const anchor = anchorForDateKey(dateKey);
  return {
    weekday: formatDate(anchor, { weekday: "short" }),
    day: formatDate(anchor, { day: "numeric" }),
    month: formatDate(anchor, { month: "short" }),
    year: dateKey.slice(0, 4),
  };
}

/** "Wed 21 Oct", or a range: "Mon 19 – Wed 21 Oct", "Fri 30 Oct – Tue 3 Nov". */
export function formatDateKeyRange(startKey: string, endKey: string): string {
  const a = dayParts(startKey);
  if (endKey === startKey) return `${a.weekday} ${a.day} ${a.month}`;
  const b = dayParts(endKey);
  if (a.year !== b.year) return `${a.weekday} ${a.day} ${a.month} ${a.year} – ${b.weekday} ${b.day} ${b.month} ${b.year}`;
  const head = a.month === b.month ? `${a.weekday} ${a.day}` : `${a.weekday} ${a.day} ${a.month}`;
  return `${head} – ${b.weekday} ${b.day} ${b.month}`;
}

function formatHours(hours: number): string {
  return `${Number(hours.toFixed(2))} h`;
}

/** "Mon 19 – Wed 21 Oct" for a multi-day job, "Wed 21 Oct" otherwise; null when unscheduled. */
export function formatScheduleDates(job: ScheduledJobWindow): string | null {
  const days = scheduleDays(job);
  if (days.length === 0) return null;
  return formatDateKeyRange(days[0].dateKey, days[days.length - 1].dateKey);
}

/** The daily hours, "7:00–15:30"; null when unscheduled or there is no end. */
export function formatScheduleHours(job: ScheduledJobWindow): string | null {
  const day = scheduleDays(job)[0];
  if (!day || !job.scheduled_end) return null;
  const time = (iso: string) => shortTime(toBusinessInputValue(iso).slice(11, 16));
  return `${time(day.startIso)}–${time(day.endIso)}`;
}

/**
 * One line for a schedule:
 *   "Booked Mon 19 – Wed 21 Oct, 7:00–15:30 each weekday (3 days, 25.5 h)"
 *   "Booked Wed 21 Oct, 9:00–11:00 (2 h)"
 * Null when unscheduled.
 */
export function describeSchedule(job: ScheduledJobWindow): string | null {
  const days = scheduleDays(job);
  const dates = formatScheduleDates(job);
  if (!dates) return null;
  const hours = formatScheduleHours(job);
  const total = formatHours(totalScheduledHours(job));
  if (days.length === 1) return `Booked ${dates}${hours ? `, ${hours}` : ""} (${total})`;
  // A weekend start or end date is booked too, so "each weekday" would be untrue.
  const each = days.some((d) => isWeekendDateKey(d.dateKey)) ? "each booked day" : "each weekday";
  return `Booked ${dates}, ${hours} ${each} (${days.length} days, ${total})`;
}
