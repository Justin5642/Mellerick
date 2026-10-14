// Display helpers for multi-day schedules (migration 0071). The day rules
// themselves live in ./scheduling.ts (byte-identical to the web copy, pinned by
// tests/unit/scheduling-multiday.test.ts) — this file only turns their output
// into text and answers "which of a job's days is this one?" for list screens.
// Every date here is a Melbourne "YYYY-MM-DD" key, never a device-local Date.
import { dateKeyInBusinessTZ, toBusinessInputValue } from "./date";
import { dayOfWeekForDateKey, scheduleDays, type ScheduleDay, type ScheduledJobWindow } from "./scheduling";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Today's Melbourne "YYYY-MM-DD" — never the device-local calendar day. */
export function businessTodayKey(now: Date = new Date()): string {
  return dateKeyInBusinessTZ(now);
}

/** "07:00" → "7:00" (24 h, as the office writes shift times). */
export function shortTime(iso: string): string {
  const hhmm = toBusinessInputValue(iso).slice(11, 16);
  return hhmm.startsWith("0") ? hhmm.slice(1) : hhmm;
}

function parts(key: string): { weekday: string; day: number; month: string; year: number } {
  const [y, m, d] = key.split("-").map(Number);
  return { weekday: WEEKDAYS[dayOfWeekForDateKey(key)], day: d, month: MONTHS[m - 1], year: y };
}

/** "Mon 19 Oct" */
export function shortDayLabel(key: string): string {
  const p = parts(key);
  return `${p.weekday} ${p.day} ${p.month}`;
}

/** "Mon 19 – Wed 21 Oct", "Fri 30 Oct – Tue 3 Nov"; one key → "Wed 21 Oct". */
export function dateRangeLabel(startKey: string, endKey: string): string {
  if (startKey === endKey) return shortDayLabel(startKey);
  const a = parts(startKey);
  const b = parts(endKey);
  if (a.year === b.year && a.month === b.month) return `${a.weekday} ${a.day} – ${shortDayLabel(endKey)}`;
  return `${shortDayLabel(startKey)} – ${shortDayLabel(endKey)}`;
}

/**
 * One line describing a job's schedule:
 *   daily   → "Mon 19 – Wed 21 Oct, 7:00–15:30 each weekday · 3 days"
 *   single  → "Wed 21 Oct, 9:00–12:00"
 * Null when unscheduled. A legacy block that crosses midnight shows its start
 * day and both times, as it always did.
 */
export function formatScheduleSummary(job: ScheduledJobWindow): string | null {
  const days = scheduleDays(job);
  if (days.length === 0 || !job.scheduled_start) return null;
  const first = days[0];
  const last = days[days.length - 1];
  const hours = `${shortTime(first.startIso)}–${shortTime(first.endIso)}`;
  if (!job.schedule_daily) {
    return job.scheduled_end ? `${shortDayLabel(first.dateKey)}, ${hours}` : `${shortDayLabel(first.dateKey)}, ${shortTime(first.startIso)}`;
  }
  return `${dateRangeLabel(first.dateKey, last.dateKey)}, ${hours} each weekday · ${days.length} day${days.length === 1 ? "" : "s"}`;
}

/** The job's block on one Melbourne day, with its position ("day 2 of 3"); null when not booked that day. */
export function scheduleDayOn(
  job: ScheduledJobWindow,
  dateKey: string,
): (ScheduleDay & { index: number; count: number }) | null {
  const days = scheduleDays(job);
  const index = days.findIndex((d) => d.dateKey === dateKey);
  return index < 0 ? null : { ...days[index], index, count: days.length };
}
