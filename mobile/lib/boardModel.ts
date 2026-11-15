// MIRROR of the web board's pure model, components/schedule/board-model.ts —
// which bookings land in which technician × day cell, how many hours each
// technician is booked, what a drop target id means, and what a move changes.
// The phone's schedule grid (components/schedule/ScheduleGrid.tsx) arranges
// its blocks with exactly these rules, so the phone and the web board cannot
// disagree about who is booked where.
//
// Everything BELOW THE IMPORTS is pinned byte-identical to the web file by
// tests/unit/board-model-mirror.test.ts (like lib/scheduling.ts). Change the
// web file first, then copy its body here. Only this header and the import
// paths may differ.
import { moveSchedule, scheduledHoursOnDay, scheduleDays, validateScheduleInput, type ScheduleDay } from "./scheduling";
import {
  bookingScheduleInput,
  bookingWindow,
  buildBookingWindow,
  sameBookingWindow,
  type BookingInsert,
  type BookingWindowColumns,
  type Booking as JobBooking,
} from "./bookings";
import { dateKeyInBusinessTZ, shiftDateKey } from "./date";

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

// ---------------------------------------------------------------------------
// Resizing — dragging a booking's left or right edge across day columns
// ---------------------------------------------------------------------------
// Week view only: its columns are days, so a horizontal drag means "more or
// fewer days". The gesture works in whole days (deltaDays); what the
// stretched booking then MEANS is lib/scheduling.ts's, reached the way the
// Schedule dialog reaches it — the booking as dialog input
// (bookingScheduleInput), new start/end dates, validateScheduleInput, then
// buildBookingWindow. So:
//
//   - The booking keeps its daily hours. A 7:00–15:30 booking stretched from
//     Tuesday to Thursday is 7:00–15:30 on Tue, Wed and Thu.
//   - One day → several: `daily` becomes true (0071's "same hours on each
//     booked day"): starts_at on the first day at the start time, ends_at on
//     the last day at the end time. Several → one: `daily` goes back to
//     false — exactly what the dialog writes for a single day.
//   - Weekends inside the new range are skipped and the endpoints are booked
//     (workdayKeysBetween), so the preview shows the days the save will.
//   - all_day is carried over as it was; the times come from the stored
//     window rather than being re-derived from "All day", so nothing else
//     moves.

export type ResizeEdge = "start" | "end";

/** Bookings on these jobs can't be resized. The board leaves such jobs out anyway; this is the belt to that. */
const CLOSED_STATUSES = new Set(["completed", "cancelled"]);

export function isClosedJob(job: Pick<BoardJob, "status">): boolean {
  return CLOSED_STATUSES.has(job.status);
}

/**
 * Why this booking can't be resized from the board, or null when it can.
 * Shown as the error when someone tries; the board hides the handles for a
 * closed job.
 */
export function resizeBlockedReason(job: Pick<BoardJob, "status">, booking: BoardBooking): string | null {
  if (isClosedJob(job)) return `This job is ${job.status} — its schedule can't be changed.`;
  if (booking.id.startsWith("pending:") || booking.id.startsWith("legacy:")) return "This booking hasn't finished saving yet.";
  // A start with no end is a one-hour placeholder: no daily hours to repeat.
  if (booking.ends_at === null) return "This booking has no end time — set its hours from the job's Schedule dialog first.";
  // A continuous block that crosses midnight (an old-style overnight booking)
  // has no "same hours each day" form.
  if (!booking.daily && dateKeyInBusinessTZ(booking.starts_at) !== dateKeyInBusinessTZ(booking.ends_at)) {
    return "This booking runs past midnight — change it from the job's Schedule dialog.";
  }
  return null;
}

export type ResizePlan =
  | {
      ok: true;
      /** The window columns to write — all four, so they always agree. */
      window: BookingWindowColumns;
      startKey: string;
      endKey: string;
      /** False when the drag came back to the same dates. */
      changed: boolean;
    }
  | { ok: false; error: string };

/**
 * Move one edge of a booking by whole days. Dragging an edge past the other
 * one stops at a single day rather than flipping the booking round.
 */
export function planBookingResize(booking: BoardBooking, edge: ResizeEdge, deltaDays: number): ResizePlan {
  const input = bookingScheduleInput(booking);
  let { startDateKey, endDateKey } = input;
  if (edge === "start") {
    startDateKey = shiftDateKey(startDateKey, deltaDays);
    if (startDateKey > endDateKey) startDateKey = endDateKey;
  } else {
    endDateKey = shiftDateKey(endDateKey, deltaDays);
    if (endDateKey < startDateKey) endDateKey = startDateKey;
  }
  // allDay off so the stored times are used as they are (see above).
  const next = { ...input, startDateKey, endDateKey, allDay: false };
  const error = validateScheduleInput(next);
  if (error) return { ok: false, error };
  const window = { ...buildBookingWindow(next), all_day: booking.all_day };
  return { ok: true, window, startKey: startDateKey, endKey: endDateKey, changed: !sameBookingWindow(window, booking) };
}

/**
 * The board while a booking's edge is being dragged: the booking drawn on its
 * PREVIEW days (hours included), and — so the chip under the pointer is never
 * unmounted mid-gesture — still drawn on any ORIGINAL day the preview drops,
 * as the same booking (same React key in the same cell). Those dropped days
 * are returned so the board can fade them as "being removed"; they carry no
 * hours.
 */
export function buildResizePreviewIndex(
  bookings: readonly BoardBooking[],
  jobsById: ReadonlyMap<string, BoardJob>,
  dayKeys: readonly string[],
  bookingDays: ReadonlyMap<string, ScheduleDay[]>,
  original: BoardBooking,
  window: BookingWindowColumns,
): { index: BoardIndex; previewDays: ScheduleDay[]; droppedDayKeys: Set<string> } {
  const previewDays = scheduleDays(bookingWindow(window));
  const shownDays = new Map(bookingDays).set(original.id, previewDays);
  const shown = bookings.map((b) => (b.id === original.id ? { ...b, ...window } : b));
  const index = buildBoardIndex(shown, jobsById, dayKeys, shownDays);
  const kept = new Set(previewDays.map((d) => d.dateKey));
  const visible = new Set(dayKeys);
  const job = jobsById.get(original.job_id);
  const originalDays = bookingDays.get(original.id) ?? scheduleDays(bookingWindow(original));
  const droppedDayKeys = new Set<string>();
  originalDays.forEach((day, i) => {
    if (kept.has(day.dateKey)) return;
    droppedDayKeys.add(day.dateKey);
    if (!job || !visible.has(day.dateKey)) return;
    const entry: BoardEntry = { job, booking: original, day, dayNumber: i + 1, dayCount: originalDays.length };
    let cellMap: Map<string, BoardEntry[]>;
    if (original.staff_id) {
      cellMap = index.byStaff.get(original.staff_id) ?? new Map();
      index.byStaff.set(original.staff_id, cellMap);
    } else {
      cellMap = index.unassigned;
    }
    const list = cellMap.get(day.dateKey) ?? [];
    list.push(entry);
    list.sort((a, b) => Date.parse(a.day.startIso) - Date.parse(b.day.startIso));
    cellMap.set(day.dateKey, list);
  });
  return { index, previewDays, droppedDayKeys };
}

/** Another booking of the same technician that a resize would run into. */
export type ResizeConflict = {
  booking: BoardBooking;
  job: BoardJob;
  /** The clashing days, each with the OTHER booking's hours that day. */
  days: ScheduleDay[];
};

/** Whether two day blocks share any time. A start-only block (no end) is an instant: it clashes when it falls inside the other. */
function blocksOverlap(a: ScheduleDay, b: ScheduleDay): boolean {
  const [as, ae, bs, be] = [a.startIso, a.endIso, b.startIso, b.endIso].map(Date.parse);
  if (ae <= as) return as >= bs && as < Math.max(be, bs + 1);
  if (be <= bs) return bs >= as && bs < ae;
  return as < be && bs < ae;
}

/**
 * The technician's other bookings whose hours overlap the resized booking on
 * a day it GAINS. Days it already had are not re-checked — a clash there was
 * on the board before the drag, and repeating it on every resize would teach
 * people to click through the warning. Two bookings on one day that don't
 * overlap in time (a morning and an afternoon) are not a clash. Unassigned
 * bookings never clash; only jobs on the board count.
 */
export function resizeConflicts(
  original: BoardBooking,
  window: BookingWindowColumns,
  bookings: readonly BoardBooking[],
  jobsById: ReadonlyMap<string, BoardJob>,
): ResizeConflict[] {
  if (!original.staff_id) return [];
  const had = new Set(scheduleDays(bookingWindow(original)).map((d) => d.dateKey));
  const gained = scheduleDays(bookingWindow(window)).filter((d) => !had.has(d.dateKey));
  if (gained.length === 0) return [];
  const conflicts: ResizeConflict[] = [];
  for (const other of bookings) {
    if (other.id === original.id || other.staff_id !== original.staff_id) continue;
    const job = jobsById.get(other.job_id);
    if (!job) continue;
    const otherDays = new Map(scheduleDays(bookingWindow(other)).map((d) => [d.dateKey, d]));
    const days: ScheduleDay[] = [];
    for (const g of gained) {
      const o = otherDays.get(g.dateKey);
      if (!o) continue;
      if (blocksOverlap(g, o)) days.push(o);
    }
    if (days.length > 0) conflicts.push({ booking: other, job, days });
  }
  return conflicts.sort((a, b) => Date.parse(a.days[0].startIso) - Date.parse(b.days[0].startIso));
}

// ---------------------------------------------------------------------------
// Who's on a tile
// ---------------------------------------------------------------------------

/**
 * The OTHER technicians booked on the same job on the same day as this
 * entry, in booking order, once each — the "+1" on a tile. The tile's own
 * technician is its row's (null in Unassigned) and is never included.
 */
export function otherStaffOnJobDay(
  entry: Pick<BoardEntry, "booking" | "day">,
  jobBookings: readonly BoardBooking[],
  bookingDays: ReadonlyMap<string, ScheduleDay[]>,
): string[] {
  const others: string[] = [];
  for (const b of jobBookings) {
    if (!b.staff_id || b.staff_id === entry.booking.staff_id || others.includes(b.staff_id)) continue;
    const days = bookingDays.get(b.id) ?? scheduleDays(bookingWindow(b));
    if (days.some((d) => d.dateKey === entry.day.dateKey)) others.push(b.staff_id);
  }
  return others;
}

/** "Dave" from "Dave Smith" (or "Dave Smith (inactive)"). */
export function firstName(fullName: string): string {
  return fullName.trim().split(/\s+/)[0] || fullName;
}

/** "DS" from "Dave Smith" — the narrowest form of a name on a tile. */
export function nameInitials(fullName: string): string {
  return fullName
    .replace(/\(.*?\)/g, "")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((n) => n[0])
    .join("")
    .toUpperCase()
    .slice(0, 2);
}
