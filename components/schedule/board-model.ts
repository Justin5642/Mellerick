// The pure half of the Team schedule board (team-schedule-view.tsx): which
// bookings land in which technician × day cell, how many hours each technician
// is booked, what a drop/paste target id means, and what a move changes. No
// I/O and no React, so tests/unit/schedule-board.test.ts can pin it without a
// DOM.
//
// THE BOARD SHOWS BOOKINGS, NOT JOBS. Each technician's row holds their OWN
// bookings (job_bookings — migration 0079 yet): Dave's
// Mon–Tue rough-in and Sam's Monday morning on the same job are two cards
// with two different windows. Before bookings, a job's one window was
// repeated under every crew member, so a pair working different days could
// not be drawn at all.
//
// Day rules (which days a multi-day booking occupies, its hours on each) are
// NOT decided here — they come from lib/scheduling.ts through bookingWindow(),
// the one place both web and mobile ask. This file only arranges its answers
// on a grid.
import { moveSchedule, scheduledHoursOnDay, scheduleDays, type ScheduleDay } from "@/lib/scheduling";
import { bookingWindow, sameBookingWindow, type BookingInsert, type JobBooking } from "@/lib/bookings";

export type BoardJob = {
  id: string;
  job_number: number;
  title: string;
  status: string;
  /** Derived from the bookings by the database; the List tab's sort key only. */
  scheduled_start: string | null;
  scheduled_end: string | null;
  // Absent (undefined) on a database without the multi-day columns yet — the
  // page falls back to its older select, and every job reads as single-day.
  schedule_daily?: boolean | null;
  schedule_all_day?: boolean | null;
  scheduled_cost_center_id?: string | null;
  /** The crew's primary assignee (trigger-derived since 0059). */
  assigned_to: string | null;
  /** Every current assignee — job_assignments ∪ assigned_to. Only the no-bookings-table fallback reads it. */
  crew: string[];
  customers?: { name?: string } | null;
  // Nullable, not optional. These are database columns that are NULL when a
  // site has no coordinates, and the generated types said so the moment the
  // client was typed (item 3.3). Declaring them `?: number` claimed the field
  // would be absent, which is a different thing and never what arrives.
  sites?: {
    name?: string;
    address_line1?: string | null;
    suburb?: string | null;
    state?: string | null;
    site_lat?: number | null;
    site_lng?: number | null;
  } | null;
};

/** A booking on the board. The cost centre's name rides along for the card. */
export type BoardBooking = JobBooking & { cost_center_name?: string | null };

/**
 * The crew of a job row as the page reads it: the primary assignee first, then
 * every job_assignments row, de-duplicated. assigned_to is folded in rather
 * than trusted to be in job_assignments because RLS shows a technician only
 * their OWN assignment rows — the primary would otherwise vanish from their view.
 */
export function crewFromRow(assignedTo: string | null, assignments: readonly { staff_id: string | null }[] | null | undefined): string[] {
  const crew: string[] = [];
  if (assignedTo) crew.push(assignedTo);
  for (const a of assignments ?? []) {
    if (a.staff_id && !crew.includes(a.staff_id)) crew.push(a.staff_id);
  }
  return crew;
}


// ---------------------------------------------------------------------------
// Target ids
// ---------------------------------------------------------------------------
// A Day-view column is just "who" (`unassigned` or `staff:<id>`) — its day is
// whichever day is shown. A Week-view cell is the intersection of a row and a
// day column, so its id carries both: `<column id>::<YYYY-MM-DD>`. Drops and
// pastes both resolve through parseBoardTarget, so the two gestures cannot
// disagree about where a booking was put.

export const UNASSIGNED_COLUMN_ID = "unassigned";
export const STAFF_COLUMN_PREFIX = "staff:";
export const WEEK_CELL_SEPARATOR = "::";

export function columnId(staffId: string | null): string {
  return staffId ? `${STAFF_COLUMN_PREFIX}${staffId}` : UNASSIGNED_COLUMN_ID;
}

export function weekCellId(staffId: string | null, dateKey: string): string {
  return `${columnId(staffId)}${WEEK_CELL_SEPARATOR}${dateKey}`;
}

/** A cell on the board: whose row (null = Unassigned) and which Melbourne day. */
export type BoardCell = { staffId: string | null; dateKey: string };

const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * What a drop/paste target id means. `shownDateKey` is the day a Day-view
 * column stands for. Null for an id that is not a board cell.
 */
export function parseBoardTarget(id: string, shownDateKey: string): BoardCell | null {
  let base = id;
  let dateKey = shownDateKey;
  const sep = id.lastIndexOf(WEEK_CELL_SEPARATOR);
  if (sep !== -1) {
    base = id.slice(0, sep);
    dateKey = id.slice(sep + WEEK_CELL_SEPARATOR.length);
  }
  if (!DATE_KEY.test(dateKey)) return null;
  if (base === UNASSIGNED_COLUMN_ID) return { staffId: null, dateKey };
  if (base.startsWith(STAFF_COLUMN_PREFIX) && base.length > STAFF_COLUMN_PREFIX.length) {
    return { staffId: base.slice(STAFF_COLUMN_PREFIX.length), dateKey };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Moves
// ---------------------------------------------------------------------------

/** The columns a move changes on the booking — only those that differ. */
export type BookingPatch = {
  staff_id?: string | null;
  starts_at?: string;
  ends_at?: string | null;
};

function sameInstant(a: string | null, b: string | null) {
  if (a === null || b === null) return a === b;
  return new Date(a).getTime() === new Date(b).getTime();
}

/** The booking's window started on `dateKey`, keeping its shape; null when unchanged. */
function movedWindow(booking: BoardBooking, dateKey: string): { starts_at: string; ends_at: string | null } | null {
  const moved = moveSchedule(bookingWindow(booking), dateKey);
  if (!moved) return null;
  // moveSchedule gives a start-only block an end equal to its start; keep it
  // start-only rather than inventing a zero-length window.
  const end = booking.ends_at === null && !booking.daily ? null : moved.scheduled_end;
  if (sameInstant(moved.scheduled_start, booking.starts_at) && sameInstant(end, booking.ends_at)) return null;
  return { starts_at: moved.scheduled_start, ends_at: end };
}

/**
 * What moving a booking from one cell to another changes. Shared by
 * drag-and-drop and cut & paste, in both views.
 *
 * Technician: the booking goes to the target row's technician (or becomes
 * unassigned). Only THIS booking — the job's other bookings, including the
 * same technician's other stages, stay where they are. That replaces the old
 * crew swap, which existed only because a job had one shared window.
 *
 * Dates: only when the target DAY differs from the day it was taken from, and
 * then via moveSchedule, so the booking STARTS on the target day and keeps its
 * shape (a daily booking its hours and number of booked days; a block its
 * time of day and length). Same day — every Day-view move, or a Week-view
 * move down a column — leaves the dates alone: moving Tuesday's chip of a
 * Mon–Wed booking to another technician's Tuesday must not restart it on
 * Tuesday.
 *
 * Null when nothing changes (dropped back where it came from).
 */
export function planBoardMove(booking: BoardBooking, source: BoardCell, target: BoardCell): BookingPatch | null {
  const patch: BookingPatch = {};
  if (target.staffId !== booking.staff_id) patch.staff_id = target.staffId;
  if (target.dateKey !== source.dateKey) {
    const moved = movedWindow(booking, target.dateKey);
    if (moved) Object.assign(patch, moved);
  }
  return Object.keys(patch).length > 0 ? patch : null;
}

/**
 * Shift-drop / Shift-paste: ADD a booking for the target technician that
 * copies the dragged one — same cost centre, same hours and shape — instead of
 * moving it. Jobs are often done in pairs; building one used to mean opening
 * the Schedule dialog. Dropped on the same day the copy is the same window;
 * on another day (Week view) it starts there, as a move would.
 *
 * Null when there is nothing to add: the Unassigned row (an unassigned copy
 * is noise), or the target already has a booking on this job with exactly
 * that window and cost centre.
 */
export function planBoardAdd(
  booking: BoardBooking,
  source: BoardCell,
  target: BoardCell,
  jobBookings: readonly BoardBooking[],
): BookingInsert | null {
  if (!target.staffId) return null;
  const window = {
    starts_at: booking.starts_at,
    ends_at: booking.ends_at,
    daily: booking.daily,
    all_day: booking.all_day,
    ...(target.dateKey !== source.dateKey ? movedWindow(booking, target.dateKey) : null),
  };
  const duplicate = jobBookings.some(
    (b) => b.job_id === booking.job_id && b.staff_id === target.staffId && b.cost_center_id === booking.cost_center_id && sameBookingWindow(b, window),
  );
  if (duplicate) return null;
  return { job_id: booking.job_id, staff_id: target.staffId, cost_center_id: booking.cost_center_id, ...window };
}

/** The booking as it will look once a patch lands — for the optimistic update. */
export function applyBoardMove(booking: BoardBooking, patch: BookingPatch): BoardBooking {
  return { ...booking, ...patch };
}

// ---------------------------------------------------------------------------
// Grid
// ---------------------------------------------------------------------------

/** One booking on one of its booked days. */
export type BoardEntry = {
  job: BoardJob;
  booking: BoardBooking;
  day: ScheduleDay;
  /** 1-based position of `day` among the booking's booked days. */
  dayNumber: number;
  dayCount: number;
};

export type BoardIndex = {
  /** staff id → day key → entries, in start-time order. */
  byStaff: Map<string, Map<string, BoardEntry[]>>;
  /** day key → unassigned bookings. */
  unassigned: Map<string, BoardEntry[]>;
  /** staff id → day key → booked hours (the sum of their own bookings). */
  hours: Map<string, Map<string, number>>;
};

/** Each booking's booked days, once — the input buildBoardIndex buckets from. */
export function daysByBooking(bookings: readonly BoardBooking[]): Map<string, ScheduleDay[]> {
  const days = new Map<string, ScheduleDay[]>();
  for (const b of bookings) days.set(b.id, scheduleDays(bookingWindow(b)));
  return days;
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V) {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

/**
 * Buckets bookings into the visible days (one day in Day view, seven in
 * Week). A booking lands in ITS technician's row (or Unassigned) on EVERY day
 * it occupies. A booking whose job is not on the board (completed or
 * cancelled) is left out.
 */
export function buildBoardIndex(
  bookings: readonly BoardBooking[],
  jobsById: ReadonlyMap<string, BoardJob>,
  dayKeys: readonly string[],
  bookingDays: ReadonlyMap<string, ScheduleDay[]>,
): BoardIndex {
  const visible = new Set(dayKeys);
  const byStaff = new Map<string, Map<string, BoardEntry[]>>();
  const unassigned = new Map<string, BoardEntry[]>();
  const hours = new Map<string, Map<string, number>>();

  for (const booking of bookings) {
    const job = jobsById.get(booking.job_id);
    if (!job) continue;
    const days = bookingDays.get(booking.id) ?? scheduleDays(bookingWindow(booking));
    days.forEach((day, i) => {
      if (!visible.has(day.dateKey)) return;
      const entry: BoardEntry = { job, booking, day, dayNumber: i + 1, dayCount: days.length };
      if (!booking.staff_id) {
        push(unassigned, day.dateKey, entry);
        return;
      }
      let staffDays = byStaff.get(booking.staff_id);
      if (!staffDays) byStaff.set(booking.staff_id, (staffDays = new Map()));
      push(staffDays, day.dateKey, entry);
      let staffHours = hours.get(booking.staff_id);
      if (!staffHours) hours.set(booking.staff_id, (staffHours = new Map()));
      staffHours.set(day.dateKey, (staffHours.get(day.dateKey) ?? 0) + scheduledHoursOnDay(bookingWindow(booking), day.dateKey));
    });
  }

  const byStart = (a: BoardEntry, b: BoardEntry) => new Date(a.day.startIso).getTime() - new Date(b.day.startIso).getTime();
  for (const list of unassigned.values()) list.sort(byStart);
  for (const staffDays of byStaff.values()) for (const list of staffDays.values()) list.sort(byStart);
  return { byStaff, unassigned, hours };
}

/**
 * The days a JOB is worked, from its bookings: one entry per day, from the
 * earliest booking start that day to the latest end. For the List tab —
 * "is this job on today?" — which can no longer ask the job's derived window:
 * a job with Mon–Tue and Thursday bookings derives Mon..Thu, which reads as
 * one block on Monday.
 */
export function jobDaysFromBookings(bookings: readonly BoardBooking[], bookingDays?: ReadonlyMap<string, ScheduleDay[]>): ScheduleDay[] {
  const byDay = new Map<string, ScheduleDay>();
  for (const b of bookings) {
    for (const d of bookingDays?.get(b.id) ?? scheduleDays(bookingWindow(b))) {
      const seen = byDay.get(d.dateKey);
      if (!seen) {
        byDay.set(d.dateKey, { ...d });
        continue;
      }
      if (Date.parse(d.startIso) < Date.parse(seen.startIso)) seen.startIso = d.startIso;
      if (Date.parse(d.endIso) > Date.parse(seen.endIso)) seen.endIso = d.endIso;
    }
  }
  return [...byDay.values()].sort((a, b) => a.dateKey.localeCompare(b.dateKey));
}

/** A technician's booked hours across the given map's days. */
export function totalHours(staffHours: ReadonlyMap<string, number> | undefined): number {
  let total = 0;
  for (const h of staffHours?.values() ?? []) total += h;
  return total;
}

/** "8.5 h", "7.75 h", "16 h" — hours to two decimals at most, trailing zeros dropped. */
export function formatHours(hours: number): string {
  return `${Math.round(hours * 100) / 100} h`;
}

/** "Day 2 of 3" for a booking on several days; null for a one-day booking. */
export function dayOfLabel(entry: Pick<BoardEntry, "dayNumber" | "dayCount">): string | null {
  return entry.dayCount > 1 ? `Day ${entry.dayNumber} of ${entry.dayCount}` : null;
}
