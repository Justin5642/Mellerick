// The phone schedule grid's pure layout: which days a view shows, where a
// booking's block sits on the Day timeline, how tall each technician's row
// is, which cell a finger is over, and what a resize or move would clash
// with. No React, no I/O — tested in scheduleGrid.test.ts.
//
// WHERE a booking lands (technician × day, hours per tech, what a move
// changes) is NOT decided here: that is ./boardModel.ts, the byte-identical
// mirror of the web board's model. This file only turns its answers into
// points on a phone screen.
import { dateKeyInBusinessTZ, shiftDateKey, withDateKeyPreservingTime } from "./date";
import { businessDayRange, scheduleDays, type ScheduleDay } from "./scheduling";
import { bookingWindow, type Booking } from "./bookings";
import type { BoardBooking, BoardEntry, BoardJob, BookingPatch } from "./boardModel";

export type GridView = "day" | "week" | "list";

/** Below this width (pt) a week of columns is unreadable without scrolling; Day is the default. */
export const WEEK_DEFAULT_MIN_WIDTH = 600;

/** Day on a phone, Week on a tablet — the view that fits. */
export function defaultGridView(widthPt: number): "day" | "week" {
  return widthPt < WEEK_DEFAULT_MIN_WIDTH ? "day" : "week";
}

// ---------------------------------------------------------------------------
// Days
// ---------------------------------------------------------------------------

/** Monday of the week containing `key` (AU/ISO), as the web lib/date.ts startOfWeekKey. */
export function startOfWeekKey(key: string): string {
  const [y, m, d] = key.split("-").map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d, 12, 0, 0)).getUTCDay(); // 0 = Sunday
  return shiftDateKey(key, dow === 0 ? -6 : 1 - dow);
}

/** The 7 keys Mon–Sun of the week containing `key`, as the web lib/date.ts weekDateKeys. */
export function weekDateKeys(key: string): string[] {
  const start = startOfWeekKey(key);
  return Array.from({ length: 7 }, (_, i) => shiftDateKey(start, i));
}

/** The day keys a view shows. */
export function visibleDayKeys(view: "day" | "week", selectedKey: string): string[] {
  return view === "week" ? weekDateKeys(selectedKey) : [selectedKey];
}

/** Prev/next: one day in Day view, one week in Week view. */
export function stepDateKey(view: "day" | "week", key: string, direction: -1 | 1): string {
  return shiftDateKey(key, direction * (view === "week" ? 7 : 1));
}

// ---------------------------------------------------------------------------
// Sizes — every touch target at least 44 pt (Apple HIG)
// ---------------------------------------------------------------------------

export const MIN_TOUCH = 44;
export const LANE_HEIGHT = 52;
export const ROW_PADDING = 6;
export const HOUR_WIDTH = 72;
export const WEEK_COLUMN_WIDTH = 116;
export const LEFT_COLUMN_WIDTH = 92;
export const NARROW_LEFT_COLUMN_WIDTH = 64;

/** Height of a row holding `lanes` stacked blocks (never less than one lane). */
export function rowHeight(lanes: number): number {
  return Math.max(1, lanes) * LANE_HEIGHT + ROW_PADDING * 2;
}

/** Each row's top, from row heights — the y-axis hit test reads these. */
export function rowOffsets(heights: readonly number[]): number[] {
  const tops: number[] = [];
  let y = 0;
  for (const h of heights) {
    tops.push(y);
    y += h;
  }
  return tops;
}

/** The row under content-y, or -1 outside every row. */
export function rowAt(tops: readonly number[], heights: readonly number[], y: number): number {
  for (let i = 0; i < tops.length; i++) {
    if (y >= tops[i] && y < tops[i] + heights[i]) return i;
  }
  return -1;
}

/** The column under content-x, clamped to the grid (a drop just past an edge lands on the edge column). */
export function columnAt(x: number, columnWidth: number, count: number): number {
  if (count <= 0) return -1;
  return Math.min(count - 1, Math.max(0, Math.floor(x / columnWidth)));
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

export type GridRow = { staffId: string | null; name: string; hours: number };

/**
 * The grid's rows, as the web board orders them: Unassigned first, then the
 * busiest technician in the period showing, then by name. A technician who
 * holds a booking but is missing from the staff list (deactivated, or the
 * staff read failed) still gets a row, named from the booking, so no booking
 * is ever left off the grid.
 */
export function gridRows(
  staff: readonly { id: string; full_name: string }[],
  bookedStaff: Iterable<string>,
  periodHours: ReadonlyMap<string, number>,
  nameFromBookings: ReadonlyMap<string, string | null>,
): GridRow[] {
  const rows = new Map<string, GridRow>();
  for (const s of staff) rows.set(s.id, { staffId: s.id, name: s.full_name, hours: periodHours.get(s.id) ?? 0 });
  for (const id of bookedStaff) {
    if (!rows.has(id)) rows.set(id, { staffId: id, name: nameFromBookings.get(id) ?? "Technician", hours: periodHours.get(id) ?? 0 });
  }
  const sorted = [...rows.values()].sort((a, b) => b.hours - a.hours || a.name.localeCompare(b.name));
  return [{ staffId: null, name: "Unassigned", hours: 0 }, ...sorted];
}

// ---------------------------------------------------------------------------
// Day timeline — blocks across the hours
// ---------------------------------------------------------------------------

export const DEFAULT_DAY_START_HOUR = 6;
export const DEFAULT_DAY_END_HOUR = 19;

/** Minutes from the start of the Melbourne day `dateKey` to `iso` (DST-safe: measured, not read off a clock). */
export function minutesIntoDay(iso: string, dateKey: string): number {
  return (Date.parse(iso) - Date.parse(businessDayRange(dateKey).dayStartIso)) / 60000;
}

/**
 * The hours the Day timeline shows: 6:00–19:00, widened to whole hours to fit
 * any block that starts earlier or ends later (clamped to the day).
 */
export function dayTimelineHours(days: readonly ScheduleDay[], dateKey: string): { startHour: number; endHour: number } {
  let start = DEFAULT_DAY_START_HOUR;
  let end = DEFAULT_DAY_END_HOUR;
  for (const d of days) {
    const s = minutesIntoDay(d.startIso, dateKey) / 60;
    const e = minutesIntoDay(d.endIso, dateKey) / 60;
    start = Math.min(start, Math.floor(s));
    end = Math.max(end, Math.ceil(e));
  }
  return { startHour: Math.max(0, start), endHour: Math.min(24, Math.max(end, start + 1)) };
}

/**
 * Where a day's block sits on the timeline, in points from its left edge. A
 * start-only booking (no end) and very short blocks are drawn MIN_TOUCH wide so
 * they stay tappable; a block running past either edge is clipped to it.
 */
export function dayBlockGeometry(
  day: ScheduleDay,
  range: { startHour: number; endHour: number },
  hourWidth = HOUR_WIDTH,
): { left: number; width: number } {
  const total = (range.endHour - range.startHour) * hourWidth;
  const toX = (iso: string) => ((minutesIntoDay(iso, day.dateKey) / 60 - range.startHour) * hourWidth);
  const left = Math.min(Math.max(0, toX(day.startIso)), Math.max(0, total - MIN_TOUCH));
  const right = Math.min(total, Math.max(toX(day.endIso), left + MIN_TOUCH));
  return { left, width: Math.max(MIN_TOUCH, right - left) };
}

/**
 * Lanes for overlapping blocks in one row: each interval gets the first lane
 * whose last block has ended. Input order does not matter.
 */
export function packLanes(items: readonly { id: string; left: number; width: number }[]): { lane: Map<string, number>; lanes: number } {
  const sorted = [...items].sort((a, b) => a.left - b.left || a.id.localeCompare(b.id));
  const laneEnds: number[] = [];
  const lane = new Map<string, number>();
  for (const it of sorted) {
    let i = laneEnds.findIndex((end) => end <= it.left);
    if (i === -1) {
      i = laneEnds.length;
      laneEnds.push(0);
    }
    laneEnds[i] = it.left + it.width;
    lane.set(it.id, i);
  }
  return { lane, lanes: laneEnds.length };
}

// ---------------------------------------------------------------------------
// Names on tiles (Feature 6)
// ---------------------------------------------------------------------------

/** "Dave Smith" → "DS" (as the web board's avatars). */
export function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .map((n) => n[0])
    .join("")
    .toUpperCase()
    .slice(0, 2);
}

/** The small label in a tile's corner: initials when the tile is narrow, first name otherwise. */
export function techShortLabel(fullName: string | null | undefined, narrow: boolean): string {
  const name = (fullName ?? "").trim();
  if (!name) return "—";
  return narrow ? initials(name) : name.split(/\s+/)[0];
}

/**
 * The OTHER technicians with a booking on the same job on the entry's day —
 * the "+N" on a tile. Unassigned bookings and the entry's own technician are
 * not counted; someone with two bookings that day counts once.
 */
export function othersOnJobDay(
  entry: Pick<BoardEntry, "booking" | "day">,
  jobBookings: readonly BoardBooking[],
  bookingDays: ReadonlyMap<string, ScheduleDay[]>,
): string[] {
  const others = new Set<string>();
  for (const b of jobBookings) {
    if (b.job_id !== entry.booking.job_id || !b.staff_id || b.staff_id === entry.booking.staff_id) continue;
    const days = bookingDays.get(b.id) ?? scheduleDays(bookingWindow(b));
    if (days.some((d) => d.dateKey === entry.day.dateKey)) others.add(b.staff_id);
  }
  return [...others];
}

// ---------------------------------------------------------------------------
// What may be moved
// ---------------------------------------------------------------------------

export const LEGACY_BOOKING_PREFIX = "legacy:";

export function isCompletedJob(job: Pick<BoardJob, "status">): boolean {
  return job.status === "completed";
}

/** Why a block cannot be dragged or resized; null when it can. */
export function moveBlockedReason(job: Pick<BoardJob, "status">, booking: Pick<BoardBooking, "id">): string | null {
  if (isCompletedJob(job)) return "This job is completed — its bookings can't be moved.";
  if (booking.id.startsWith(LEGACY_BOOKING_PREFIX)) return "This job has no bookings yet. Use Reschedule from its menu.";
  return null;
}

/**
 * Stand-in bookings for jobs that have none — job_bookings not on this
 * database yet, or a job the bookings read could not cover — so the job still
 * shows on the grid under its primary assignee (or Unassigned). Read-only:
 * their ids are "legacy:…" and moveBlockedReason refuses them.
 */
export function legacyBookingsFor(
  jobs: readonly (Pick<BoardJob, "id" | "assigned_to" | "scheduled_start" | "scheduled_end" | "schedule_daily" | "schedule_all_day">)[],
  bookings: readonly Pick<Booking, "job_id">[],
): BoardBooking[] {
  const withBookings = new Set(bookings.map((b) => b.job_id));
  const out: BoardBooking[] = [];
  for (const j of jobs) {
    if (withBookings.has(j.id) || !j.scheduled_start) continue;
    out.push({
      id: `${LEGACY_BOOKING_PREFIX}${j.id}`,
      job_id: j.id,
      staff_id: j.assigned_to,
      cost_center_id: null,
      starts_at: j.scheduled_start,
      ends_at: j.scheduled_end,
      daily: !!j.schedule_daily,
      all_day: !!j.schedule_all_day,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Resize by whole days
// ---------------------------------------------------------------------------

/** Whether a booking can be stretched across days: it needs an end, and a block must sit inside one day. */
export function canResizeByDays(booking: Pick<Booking, "starts_at" | "ends_at" | "daily">): boolean {
  if (!booking.ends_at) return false;
  return booking.daily || dateKeyInBusinessTZ(booking.starts_at) === dateKeyInBusinessTZ(booking.ends_at);
}

/** The day the booking's last booked day falls on — where the resize handle sits. */
export function bookingEndKey(booking: Pick<Booking, "starts_at" | "ends_at">): string {
  return dateKeyInBusinessTZ(booking.ends_at ?? booking.starts_at);
}

/**
 * Stretching (or shrinking) a booking so its LAST day is `newEndKey`. The
 * daily hours stay; the booking becomes daily (the same hours on each booked
 * day, 0071's rule — weekends in between skipped). Null when nothing changes,
 * when it would end before it starts, or when the booking cannot be resized.
 */
export function planResize(booking: Pick<Booking, "starts_at" | "ends_at" | "daily">, newEndKey: string): BookingPatch & { daily?: boolean } | null {
  if (!canResizeByDays(booking) || !booking.ends_at) return null;
  if (newEndKey < dateKeyInBusinessTZ(booking.starts_at)) return null;
  if (newEndKey === bookingEndKey(booking)) return null;
  return { ends_at: withDateKeyPreservingTime(booking.ends_at, newEndKey), daily: true };
}

// ---------------------------------------------------------------------------
// Clashes — warn, never block
// ---------------------------------------------------------------------------

export type Clash = { booking: BoardBooking; dateKey: string };

/**
 * The same technician's OTHER bookings whose hours overlap `after` on any
 * booked day. Unassigned bookings never clash. Only bookings in `all` are
 * checked — the grid passes what it has loaded.
 */
export function bookingClashes(after: BoardBooking, all: readonly BoardBooking[]): Clash[] {
  if (!after.staff_id) return [];
  const mine = scheduleDays(bookingWindow(after));
  const clashes: Clash[] = [];
  for (const other of all) {
    if (other.id === after.id || other.staff_id !== after.staff_id) continue;
    const theirs = scheduleDays(bookingWindow(other));
    for (const d of mine) {
      const t = theirs.find((x) => x.dateKey === d.dateKey);
      if (!t) continue;
      const overlap = Date.parse(d.startIso) < Date.parse(t.endIso) && Date.parse(t.startIso) < Date.parse(d.endIso);
      // A start-only booking (start = end) overlaps anything running at its start.
      const instant = d.startIso === d.endIso && Date.parse(t.startIso) <= Date.parse(d.startIso) && Date.parse(d.startIso) < Date.parse(t.endIso);
      if (overlap || instant) {
        clashes.push({ booking: other, dateKey: d.dateKey });
        break;
      }
    }
  }
  return clashes;
}
