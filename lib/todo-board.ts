// The pure rules behind the to-do list sitting BESIDE the schedule board
// (components/schedule/team-schedule-view.tsx + todo-board-panel.tsx):
//
//   - how many hours each technician still has free on a day (the "gap" the
//     office fills from the to-do list, so labour isn't left unbooked);
//   - what booking a to-do job dropped on a technician's day becomes;
//   - what dragging a booking back onto the to-do list does to the job.
//
// No I/O and no React, so tests/unit/todo-board.test.ts pins it without a
// DOM. Day rules (which days a booking occupies, its hours each day) are
// lib/scheduling.ts's, reached through lib/bookings.ts — nothing is
// re-derived here. HOURS ONLY: nothing here takes or returns money.
import { DEFAULT_SHIFT_END_TIME, DEFAULT_SHIFT_START_TIME, isWeekendDateKey, scheduleDays, type ScheduleDay } from "./scheduling";
import { bookingWindow, buildBookingWindow, type BookingInsert, type JobBooking } from "./bookings";
import { toBusinessInputValue } from "./date";
import type { LeaveDay } from "./staff-leave";

/** A standard working day's bookable hours (7:00–15:30 less the 30 min break). */
export const STANDARD_DAY_HOURS = 8;

// ---------------------------------------------------------------------------
// Unbooked hours ("gaps")
// ---------------------------------------------------------------------------

export type DayGap =
  /** Bookable hours left that day (0 = fully booked). */
  | { kind: "free"; hours: number }
  /** On leave for the day (or a part day whose hours aren't known) — not bookable, so not a gap. */
  | { kind: "unavailable" }
  /** Weekend or past: no gap to fill. */
  | { kind: "none" };

/**
 * A technician's unbooked hours on one day: the standard day less what is
 * booked, never negative. Leave is NOT unbooked time — a full day (or a part
 * day of unknown hours) makes the day unavailable; a part day with known hours
 * comes off the standard day like a booking. Weekends and days before today
 * have no gap (nobody fills last Tuesday).
 */
export function unbookedHours(args: {
  dateKey: string;
  todayKey: string;
  bookedHours: number;
  leaveDays?: readonly Pick<LeaveDay, "fullDay" | "hours">[];
}): DayGap {
  const { dateKey, todayKey, bookedHours, leaveDays = [] } = args;
  if (dateKey < todayKey || isWeekendDateKey(dateKey)) return { kind: "none" };
  let leaveHours = 0;
  for (const l of leaveDays) {
    if (l.fullDay || l.hours === null) return { kind: "unavailable" };
    leaveHours += l.hours;
  }
  const free = STANDARD_DAY_HOURS - Math.max(0, bookedHours) - leaveHours;
  return { kind: "free", hours: Math.max(0, Math.round(free * 100) / 100) };
}

// ---------------------------------------------------------------------------
// Drag in: a to-do job dropped on a technician's day (or Unassigned)
// ---------------------------------------------------------------------------

const QUARTER_MINUTES = 15;
/** A part-day block never starts later than this, so it stays inside the working day. */
const LATEST_GAP_START = "15:30";

function minutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

function hhmm(totalMinutes: number): string {
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function wallClock(iso: string): string {
  return toBusinessInputValue(iso).slice(11, 16);
}

/**
 * The booking a to-do job becomes when dropped on a cell — always ONE day
 * (multi-day work is stretched afterwards with the board's edge handles, or
 * set in the job's Schedule dialog).
 *
 * - No estimate, or one of a standard day or more: "All day" (7:00–15:30),
 *   exactly what the Schedule dialog's All day writes.
 * - A shorter estimate: a block of that many hours (rounded up to the quarter
 *   hour) starting at 7:00 — or, when the technician already has work that
 *   day, straight after their last booking ends, so the job fills the gap
 *   rather than overlapping it. A gap that would start after 15:30 falls back
 *   to 7:00 (the clash check then asks).
 *
 * `dayBlocks` is the target technician's booked blocks on that day (empty for
 * Unassigned). `costCenterId` is the job's PO line the office picked in the
 * drop's confirm — every booking asks for one (19 Nov 2026); null only for a
 * caller that hasn't asked yet.
 */
export function planTodoDrop(args: {
  jobId: string;
  staffId: string | null;
  dateKey: string;
  estimateHours: number | null;
  dayBlocks?: readonly Pick<ScheduleDay, "dateKey" | "endIso">[];
  costCenterId?: string | null;
}): BookingInsert {
  const { jobId, staffId, dateKey, estimateHours, dayBlocks = [], costCenterId = null } = args;
  const base = { job_id: jobId, staff_id: staffId, cost_center_id: costCenterId };
  const partDay = estimateHours !== null && estimateHours > 0 && estimateHours < STANDARD_DAY_HOURS;
  if (!partDay) {
    return {
      ...base,
      ...buildBookingWindow({
        startDateKey: dateKey,
        endDateKey: dateKey,
        startTime: DEFAULT_SHIFT_START_TIME,
        endTime: DEFAULT_SHIFT_END_TIME,
        allDay: true,
      }),
    };
  }
  const length = Math.ceil((estimateHours * 60) / QUARTER_MINUTES) * QUARTER_MINUTES;
  let start = minutes(DEFAULT_SHIFT_START_TIME);
  const lastEnd = dayBlocks
    .filter((d) => d.dateKey === dateKey)
    .map((d) => minutes(wallClock(d.endIso)))
    .reduce((a, b) => Math.max(a, b), -1);
  if (lastEnd > start) {
    const rounded = Math.ceil(lastEnd / QUARTER_MINUTES) * QUARTER_MINUTES;
    if (rounded <= minutes(LATEST_GAP_START)) start = rounded;
  }
  const end = Math.min(start + length, 23 * 60 + 45);
  return {
    ...base,
    ...buildBookingWindow({ startDateKey: dateKey, endDateKey: dateKey, startTime: hhmm(start), endTime: hhmm(end), allDay: false }),
  };
}

/**
 * The technician's other bookings that the new one overlaps in time — the
 * "already booked then" question, as a resize asks it. Unassigned never clashes.
 */
export function newBookingClashes<B extends Pick<JobBooking, "id" | "job_id" | "staff_id" | "starts_at" | "ends_at" | "daily" | "all_day">>(
  insert: Pick<BookingInsert, "staff_id" | "starts_at" | "ends_at" | "daily" | "all_day">,
  bookings: readonly B[],
): B[] {
  if (!insert.staff_id) return [];
  const mine = scheduleDays(bookingWindow(insert));
  const out: B[] = [];
  for (const other of bookings) {
    if (other.staff_id !== insert.staff_id) continue;
    const theirs = new Map(scheduleDays(bookingWindow(other)).map((d) => [d.dateKey, d]));
    if (mine.some((d) => { const o = theirs.get(d.dateKey); return !!o && overlaps(d, o); })) out.push(other);
  }
  return out;
}

function overlaps(a: ScheduleDay, b: ScheduleDay): boolean {
  const [as, ae, bs, be] = [a.startIso, a.endIso, b.startIso, b.endIso].map(Date.parse);
  if (ae <= as) return as >= bs && as < Math.max(be, bs + 1);
  if (be <= bs) return bs >= as && bs < ae;
  return as < be && bs < ae;
}

/**
 * The job write that follows a successful drop: off the to-do list (the
 * 0067 trigger clears it anyway once 0079 derives a new scheduled_start, but a
 * job listed while it already had a start would otherwise stay listed), and a
 * pending job becomes scheduled — the Schedule dialog's rule. Any other status
 * (on hold, in progress) is left alone.
 */
export function jobPatchAfterDrop(status: string): { todo_listed_at: null; todo_listed_by: null; status?: "scheduled" } {
  return { todo_listed_at: null, todo_listed_by: null, ...(status === "pending" ? { status: "scheduled" as const } : null) };
}

// ---------------------------------------------------------------------------
// Drag out: a booking dropped back on the to-do list
// ---------------------------------------------------------------------------

export type DragOutPlan =
  /**
   * The job's last booking: delete it and put the job on the to-do list. A
   * `scheduled` job goes back to `pending` (`status` set) — the reverse of the
   * dialog's pending → scheduled — so 0067's trigger lets it be listed; an
   * on-hold or pending job keeps its status.
   */
  | { kind: "list"; status?: "pending" }
  /**
   * Delete only this booking; the job is NOT listed. Either it still has
   * other bookings (it is still on the schedule — listing it would be cleared
   * by 0067's trigger the moment its status says scheduled, and a job can't be
   * both), or it is in progress (work has started; 0067 never lists one).
   */
  | { kind: "remove"; reason: "other-bookings" | "in-progress"; otherBookings: number }
  | { kind: "refuse"; reason: string };

/** Statuses whose job may be put back on the list once its last booking goes. */
const LISTABLE_AFTER_DRAG_OUT = new Set(["pending", "scheduled", "on_hold"]);

/**
 * What dragging this booking onto the to-do list does. Always deletes THIS
 * booking only — never another technician's on the same job.
 */
export function planDragOut(
  booking: Pick<JobBooking, "id" | "job_id">,
  jobBookings: readonly Pick<JobBooking, "id" | "job_id">[],
  status: string,
): DragOutPlan {
  if (booking.id.startsWith("pending:") || booking.id.startsWith("legacy:")) {
    return { kind: "refuse", reason: "This booking hasn't finished saving yet." };
  }
  if (status === "completed" || status === "cancelled") {
    return { kind: "refuse", reason: `This job is ${status} — its schedule can't be changed.` };
  }
  const others = jobBookings.filter((b) => b.job_id === booking.job_id && b.id !== booking.id).length;
  if (others > 0) return { kind: "remove", reason: "other-bookings", otherBookings: others };
  if (!LISTABLE_AFTER_DRAG_OUT.has(status)) return { kind: "remove", reason: "in-progress", otherBookings: 0 };
  return status === "scheduled" ? { kind: "list", status: "pending" } : { kind: "list" };
}

/** The confirm dialog's words for a drag-out. `when` is the booking's day(s), e.g. "Thursday" or "Mon 17 – Wed 19 Nov". */
export function describeDragOut(plan: Exclude<DragOutPlan, { kind: "refuse" }>, args: { jobNumber: number; who: string | null; when: string }): {
  title: string;
  detail: string;
  action: string;
} {
  const whose = args.who ? `${args.who}'s ${args.when}` : `the unassigned booking on ${args.when}`;
  if (plan.kind === "list") {
    return {
      title: `Take #${args.jobNumber} off ${whose} and put it back on the to-do list?`,
      detail: "It's the job's only booking, so the job comes off the schedule" + (plan.status ? " and goes back to Pending." : "."),
      action: "Put on to-do list",
    };
  }
  return {
    title: `Take #${args.jobNumber} off ${whose}?`,
    detail:
      plan.reason === "other-bookings"
        ? `The job still has ${plan.otherBookings} other booking${plan.otherBookings === 1 ? "" : "s"}, so it stays on the schedule and doesn't go on the to-do list. Only this booking is removed.`
        : "The job is in progress, so it can't go on the to-do list. Only this booking is removed.",
    action: "Remove booking",
  };
}

// ---------------------------------------------------------------------------
// Drag ids
// ---------------------------------------------------------------------------

/** The to-do panel's drop target. */
export const TODO_PANEL_DROP_ID = "todo-panel";
const TODO_DRAG_PREFIX = "todo:";

export function todoDragId(jobId: string): string {
  return `${TODO_DRAG_PREFIX}${jobId}`;
}

export function todoJobIdFromDragId(id: string): string | null {
  return id.startsWith(TODO_DRAG_PREFIX) && id.length > TODO_DRAG_PREFIX.length ? id.slice(TODO_DRAG_PREFIX.length) : null;
}

// ---------------------------------------------------------------------------
// "Add job…" search
// ---------------------------------------------------------------------------

/** At most this many search results, like the other pickers. */
export const TODO_SEARCH_LIMIT = 20;

/**
 * A job may be ADDED from the panel when 0067 would list it (pending or on
 * hold), it isn't already listed, and it has nothing booked — a scheduled job
 * belongs on the board, not the list.
 */
export function canAddToTodo(job: { status: string; todo_listed_at: string | null; scheduled_start: string | null }): boolean {
  return (job.status === "pending" || job.status === "on_hold") && !job.todo_listed_at && !job.scheduled_start;
}

/** The search box as a job number when it is one ("#123", "123"); otherwise null. */
export function jobNumberQuery(q: string): number | null {
  const m = q.trim().match(/^#?(\d{1,9})$/);
  return m ? Number(m[1]) : null;
}
