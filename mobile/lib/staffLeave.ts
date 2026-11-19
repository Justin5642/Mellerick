// Staff leave on the schedule: which days and hours a leave record covers,
// what it is called on a tile, and which bookings it clashes with. Pure — no
// I/O, no React. Mirrored byte-identical (below the imports) at
// ../lib/staff-leave.ts (the web copy) and pinned by tests/unit/staff-leave.test.ts, so
// the website board and the phone grid agree on every leave day.
//
// THE SOURCE is staff_leave (0014): one row per period of leave, logged by an
// admin in Staff → Cost & Leave → Leave Log or imported from Xero Payroll
// (0101). It holds dates and the TOTAL hours of the period; since 0112 — a draft, not applied yet a part
// day may also carry start_time/end_time (Melbourne wall-clock). The schedule
// reads it through schedule_leave() (0112), which blanks leave_type for anyone
// the "who sees the leave type" setting excludes — a null type is shown as
// "Unavailable", never guessed.
//
// DAY RULES
//   - Leave covers the WEEKDAYS from start_date to end_date. Saturdays and
//     Sundays inside the range are not leave (Xero counts working days); a
//     range made only of weekend days covers those days, since it was entered
//     deliberately.
//   - With start_time/end_time: those hours on each covered day (a part day).
//   - Without: the period's hours are spread evenly over the covered days. A
//     day with FULL_DAY_MIN_HOURS or more (or unknown hours) is a full day; a
//     smaller share is a part day of unknown time, so it still covers the
//     whole Melbourne day for clash checks — better a warning too many than a
//     technician booked while they are at the doctor.
import { fromBusinessInputValue, shiftDateKey } from "./date";
import { MAX_SCHEDULE_DAYS, isWeekendDateKey, scheduleDays, type ScheduleDay } from "./scheduling";

export type LeaveTypeKey = "sick" | "annual" | "public_holiday" | "long_service" | "other";

/** One leave record as the schedule receives it (schedule_leave(), 0112). */
export interface ScheduleLeave {
  /** The staff_leave id — only an admin receives it (the record itself is admin-only). */
  id: string | null;
  staff_id: string;
  /** "YYYY-MM-DD" (Melbourne calendar days). */
  start_date: string;
  end_date: string;
  /** Total hours of the period; null when unknown. */
  hours: number | null;
  /** "HH:MM" or "HH:MM:SS" — a part day's hours, the same on each covered day. */
  start_time: string | null;
  end_time: string | null;
  /** Null when the caller may not see the type: shown as "Unavailable". */
  leave_type: string | null;
}

/** One covered day of a leave record. */
export interface LeaveDay {
  leave: ScheduleLeave;
  dateKey: string;
  /** The covered span, as UTC ISO instants (the whole Melbourne day for a full day or a part day of unknown time). */
  startIso: string;
  endIso: string;
  /** Leave hours on this day; null when unknown. */
  hours: number | null;
  fullDay: boolean;
  /** True when start_time/end_time say which hours. */
  timed: boolean;
}

/** A spread share of at least this many hours counts as a whole day (a standard day is 7.6 h). */
export const FULL_DAY_MIN_HOURS = 6;

const LABELS: Record<LeaveTypeKey, string> = {
  sick: "Sick",
  annual: "Annual leave",
  public_holiday: "Public holiday",
  long_service: "Long service leave",
  other: "Leave",
};

export const UNAVAILABLE_LABEL = "Unavailable";

function typeKey(type: string | null | undefined): LeaveTypeKey | null {
  if (!type) return null;
  return (Object.prototype.hasOwnProperty.call(LABELS, type) ? type : "other") as LeaveTypeKey;
}

/** "Sick", "Annual leave", … — or "Unavailable" when the type was withheld. */
export function leaveLabel(type: string | null | undefined): string {
  const key = typeKey(type);
  return key ? LABELS[key] : UNAVAILABLE_LABEL;
}

export type LeaveColour = { bg: string; border: string; text: string };

/**
 * Colours per type, chosen to stand apart from job tiles (white/blue cards on
 * the web, status colours on the phone): rose for sick, teal for annual, etc.
 * Withheld types share one neutral slate.
 */
export const LEAVE_COLOURS: Record<LeaveTypeKey | "unavailable", LeaveColour> = {
  sick: { bg: "#ffe4e6", border: "#e11d48", text: "#9f1239" },
  annual: { bg: "#ccfbf1", border: "#0d9488", text: "#115e59" },
  public_holiday: { bg: "#ede9fe", border: "#7c3aed", text: "#5b21b6" },
  long_service: { bg: "#e0f2fe", border: "#0284c7", text: "#075985" },
  other: { bg: "#fef3c7", border: "#d97706", text: "#92400e" },
  unavailable: { bg: "#e2e8f0", border: "#475569", text: "#334155" },
};

export function leaveColour(type: string | null | undefined): LeaveColour {
  return LEAVE_COLOURS[typeKey(type) ?? "unavailable"];
}

function hhmm(time: string): string {
  return time.slice(0, 5);
}

const TIME = /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/;

/** Null when a part day's times are usable (both empty, or both set with end after start); otherwise a message. */
export function validateLeaveTimes(startTime: string | null | undefined, endTime: string | null | undefined): string | null {
  const s = startTime || null;
  const e = endTime || null;
  if (!s && !e) return null;
  if (!s || !e) return "Give both a start and an end time for a part day, or neither.";
  if (!TIME.test(s) || !TIME.test(e)) return "Times must be HH:MM.";
  if (hhmm(e) <= hhmm(s)) return "The end time must be after the start time.";
  return null;
}

/** The calendar days a leave record covers (see DAY RULES). [] when end < start. */
export function leaveDateKeys(leave: Pick<ScheduleLeave, "start_date" | "end_date">): string[] {
  if (!leave.start_date || !leave.end_date || leave.end_date < leave.start_date) return [];
  const all: string[] = [];
  for (let key = leave.start_date, n = 0; key <= leave.end_date && n < MAX_SCHEDULE_DAYS; key = shiftDateKey(key, 1), n++) all.push(key);
  const weekdays = all.filter((k) => !isWeekendDateKey(k));
  return weekdays.length > 0 ? weekdays : all;
}

/** Every covered day of a leave record, with its hours and span. */
export function leaveDays(leave: ScheduleLeave): LeaveDay[] {
  const keys = leaveDateKeys(leave);
  if (keys.length === 0) return [];
  const timed = !!leave.start_time && !!leave.end_time && validateLeaveTimes(leave.start_time, leave.end_time) === null;
  return keys.map((dateKey) => {
    if (timed) {
      const startIso = fromBusinessInputValue(`${dateKey}T${hhmm(leave.start_time!)}`);
      const endIso = fromBusinessInputValue(`${dateKey}T${hhmm(leave.end_time!)}`);
      const hours = (Date.parse(endIso) - Date.parse(startIso)) / 3_600_000;
      return { leave, dateKey, startIso, endIso, hours, fullDay: hours >= FULL_DAY_MIN_HOURS, timed: true };
    }
    const hours = leave.hours == null || !Number.isFinite(Number(leave.hours)) ? null : Math.round((Number(leave.hours) / keys.length) * 100) / 100;
    return {
      leave,
      dateKey,
      startIso: fromBusinessInputValue(`${dateKey}T00:00`),
      endIso: fromBusinessInputValue(`${shiftDateKey(dateKey, 1)}T00:00`),
      hours,
      fullDay: hours === null || hours >= FULL_DAY_MIN_HOURS,
      timed: false,
    };
  });
}

/** "Sick", "Sick · 12:00–15:30", "Sick · 4 h" — the text on a leave tile for one day. */
export function leaveDayLabel(day: LeaveDay): string {
  const label = leaveLabel(day.leave.leave_type);
  if (day.timed) return `${label} · ${hhmm(day.leave.start_time!)}–${hhmm(day.leave.end_time!)}`;
  if (!day.fullDay && day.hours !== null) return `${label} · ${Math.round(day.hours * 100) / 100} h`;
  return label;
}

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Tue 18 Nov" for a "YYYY-MM-DD" key — the same text on both platforms. */
export function leaveDateLabel(dateKey: string): string {
  const [y, m, d] = dateKey.split("-").map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d, 12)).getUTCDay();
  return `${DOW[dow]} ${d} ${MON[m - 1]}`;
}

/** "Tue 18 Nov" or "Tue 18 Nov – Fri 21 Nov" for a record's dates. */
export function leaveRangeLabel(leave: Pick<ScheduleLeave, "start_date" | "end_date">): string {
  return leave.start_date === leave.end_date
    ? leaveDateLabel(leave.start_date)
    : `${leaveDateLabel(leave.start_date)} – ${leaveDateLabel(leave.end_date)}`;
}

/** staff id → day key → that person's leave on that day, for the days shown. */
export type LeaveIndex = Map<string, Map<string, LeaveDay[]>>;

export function buildLeaveIndex(leave: readonly ScheduleLeave[], dayKeys: readonly string[]): LeaveIndex {
  const visible = new Set(dayKeys);
  const index: LeaveIndex = new Map();
  for (const l of leave) {
    if (!l.staff_id) continue;
    for (const day of leaveDays(l)) {
      if (!visible.has(day.dateKey)) continue;
      let byDay = index.get(l.staff_id);
      if (!byDay) index.set(l.staff_id, (byDay = new Map()));
      const list = byDay.get(day.dateKey);
      if (list) list.push(day);
      else byDay.set(day.dateKey, [day]);
    }
  }
  for (const byDay of index.values()) for (const list of byDay.values()) list.sort((a, b) => Date.parse(a.startIso) - Date.parse(b.startIso));
  return index;
}

/** A booked day that falls on leave. */
export interface LeaveConflict {
  dateKey: string;
  leaveDay: LeaveDay;
}

function spansOverlap(aStart: string, aEnd: string, bStart: string, bEnd: string): boolean {
  const [as, ae, bs, be] = [aStart, aEnd, bStart, bEnd].map(Date.parse);
  // A start-only block (start = end) is an instant: it clashes when it falls inside the other.
  if (ae <= as) return as >= bs && as < be;
  return as < be && bs < ae;
}

/**
 * The days of `bookedDays` (one technician's booked blocks) that fall on that
 * technician's leave. A timed part day clashes only with hours it overlaps; a
 * full day or a part day of unknown time clashes with anything that day.
 * `fromDateKey` ignores days before it (past days need no reassigning).
 */
export function leaveConflictsForDays(
  staffId: string | null | undefined,
  bookedDays: readonly ScheduleDay[],
  leave: readonly ScheduleLeave[],
  fromDateKey?: string,
): LeaveConflict[] {
  if (!staffId) return [];
  const theirs = leave.filter((l) => l.staff_id === staffId);
  if (theirs.length === 0) return [];
  const conflicts: LeaveConflict[] = [];
  const seen = new Set<string>();
  for (const l of theirs) {
    const days = new Map(leaveDays(l).map((d) => [d.dateKey, d]));
    for (const b of bookedDays) {
      if (fromDateKey && b.dateKey < fromDateKey) continue;
      const ld = days.get(b.dateKey);
      if (!ld || seen.has(b.dateKey)) continue;
      if (spansOverlap(b.startIso, b.endIso, ld.startIso, ld.endIso)) {
        conflicts.push({ dateKey: b.dateKey, leaveDay: ld });
        seen.add(b.dateKey);
      }
    }
  }
  return conflicts.sort((a, b) => a.dateKey.localeCompare(b.dateKey));
}

/** The booking-window shape both platforms' bookings share. */
export interface LeaveCheckBooking {
  staff_id: string | null;
  starts_at: string;
  ends_at: string | null;
  daily: boolean;
}

/** The booked days of a booking (lib/scheduling.ts's rules). */
export function bookingDaysForLeave(booking: Pick<LeaveCheckBooking, "starts_at" | "ends_at" | "daily">): ScheduleDay[] {
  return scheduleDays({ scheduled_start: booking.starts_at, scheduled_end: booking.ends_at, schedule_daily: booking.daily });
}

/** The days a booking for its technician falls on their leave. */
export function bookingLeaveConflicts(booking: LeaveCheckBooking, leave: readonly ScheduleLeave[], fromDateKey?: string): LeaveConflict[] {
  return leaveConflictsForDays(booking.staff_id, bookingDaysForLeave(booking), leave, fromDateKey);
}

/**
 * Booking id → its clashes, for bookings that need reassigning: booked for
 * someone on a day (from `fromDateKey` on) they are on leave.
 */
export function bookingsNeedingReassignment<B extends LeaveCheckBooking & { id: string }>(
  bookings: readonly B[],
  leave: readonly ScheduleLeave[],
  fromDateKey?: string,
): Map<string, LeaveConflict[]> {
  const out = new Map<string, LeaveConflict[]>();
  if (leave.length === 0) return out;
  for (const b of bookings) {
    const c = bookingLeaveConflicts(b, leave, fromDateKey);
    if (c.length > 0) out.set(b.id, c);
  }
  return out;
}

export const NEEDS_REASSIGNING = "Needs reassigning";

/** "Dave is off: Sick Tue 18 Nov, Sick · 4 h Wed 19 Nov" — the line a confirm dialog shows. */
export function describeLeaveConflicts(name: string, conflicts: readonly LeaveConflict[], max = 4): string {
  const parts = conflicts.slice(0, max).map((c) => `${leaveDayLabel(c.leaveDay)} ${leaveDateLabel(c.dateKey)}`);
  const more = conflicts.length > max ? ` and ${conflicts.length - max} more day${conflicts.length - max === 1 ? "" : "s"}` : "";
  return `${name} is ${conflicts.some((c) => c.leaveDay.leave.leave_type) ? "on leave" : "unavailable"}: ${parts.join(", ")}${more}.`;
}

// ---------------------------------------------------------------------------
// Who sees the leave type (schedule_settings.leave_type_visible_to, 0112)
// ---------------------------------------------------------------------------
// Enforced by schedule_leave() in the database; these mirror it for the
// Settings card and for tests.

export type LeaveTypeAudience = "office_admin" | "admin" | "everyone";
export const DEFAULT_LEAVE_TYPE_AUDIENCE: LeaveTypeAudience = "office_admin";
export const LEAVE_TYPE_AUDIENCES: { value: LeaveTypeAudience; label: string }[] = [
  { value: "office_admin", label: "Office and admin" },
  { value: "admin", label: "Admin only" },
  { value: "everyone", label: "Everyone, technicians included" },
];

export function canSeeLeaveType(role: string | null | undefined, audience: LeaveTypeAudience = DEFAULT_LEAVE_TYPE_AUDIENCE): boolean {
  if (audience === "everyone") return true;
  if (audience === "admin") return role === "admin";
  return role === "admin" || role === "office";
}

/**
 * A read error that means "this database has no leave on the schedule yet"
 * (0112 not applied: function or column missing) — show no leave, never an error.
 */
export function isLeaveSourceMissing(error: { code?: string | null } | null | undefined): boolean {
  const code = error?.code ?? "";
  return code === "42883" || code === "PGRST202" || code === "42P01" || code === "PGRST205" || code === "42703" || code === "PGRST204";
}

/** The date span to fetch leave for, given the day keys on screen (padded so a step either way has it). */
export function leaveFetchRange(dayKeys: readonly string[], padDays = 7): { from: string; to: string } | null {
  if (dayKeys.length === 0) return null;
  const sorted = [...dayKeys].sort();
  return { from: shiftDateKey(sorted[0], -padDays), to: shiftDateKey(sorted[sorted.length - 1], padDays) };
}
