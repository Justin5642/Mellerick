// The pure half of the Team schedule board (team-schedule-view.tsx): which
// jobs land in which technician × day cell, how many hours each technician is
// booked, what a drop/paste target id means, and what a move changes. No I/O
// and no React, so tests/unit/schedule-board.test.ts can pin it without a DOM.
//
// Day rules (which days a multi-day job occupies, its hours on each) are NOT
// decided here — they come from lib/scheduling.ts, the one place both web and
// mobile ask. This file only arranges its answers on a grid.
import { moveSchedule, scheduledHoursOnDay, scheduleDays, type ScheduleDay } from "@/lib/scheduling";
import { swapCrewMember } from "@/lib/schedule-dispatch";

export type BoardJob = {
  id: string;
  job_number: number;
  title: string;
  status: string;
  scheduled_start: string | null;
  scheduled_end: string | null;
  // Absent (undefined) on a database without the multi-day columns yet — the
  // page falls back to its older select, and every job reads as single-day.
  schedule_daily?: boolean | null;
  schedule_all_day?: boolean | null;
  /** The crew's primary assignee (trigger-derived since 0059). Kept for reference; rows come from `crew`. */
  assigned_to: string | null;
  /** Every current assignee — job_assignments ∪ assigned_to. The board shows the job in each one's row. */
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
// disagree about where a job was put.

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

export type BoardMovePlan = {
  /** The new crew, or null when the crew does not change. */
  crew: string[] | null;
  /** The new window, or null when the dates do not change. */
  dates: { scheduled_start: string; scheduled_end: string | null } | null;
};

function sameMembers(a: readonly string[], b: readonly string[]) {
  return a.length === b.length && a.every((id) => b.includes(id));
}

function sameInstant(a: string | null, b: string | null) {
  if (a === null || b === null) return a === b;
  return new Date(a).getTime() === new Date(b).getTime();
}

/**
 * What moving a job from one cell to another changes. Shared by drag-and-drop
 * and cut & paste, in both views.
 *
 * Crew: the source row's technician is swapped for the target row's
 * (swapCrewMember) — the rest of the crew stays.
 *
 * Dates: only when the target DAY differs from the day it was taken from, and
 * then via moveSchedule, so the job STARTS on the target day and keeps its
 * shape (a daily job its hours and number of booked days; a block its time of
 * day and length). Same day — every Day-view move, or a Week-view move down a
 * column — leaves the dates alone: moving Tuesday's chip of a Mon–Wed job to
 * another technician's Tuesday must not restart the job on Tuesday.
 *
 * Null when nothing changes (dropped back where it came from).
 */
export function planBoardMove(job: BoardJob, source: BoardCell, target: BoardCell): BoardMovePlan | null {
  const nextCrew = swapCrewMember(job.crew, source.staffId, target.staffId);
  const crew = sameMembers(nextCrew, job.crew) ? null : nextCrew;

  let dates: BoardMovePlan["dates"] = null;
  if (target.dateKey !== source.dateKey) {
    const moved = moveSchedule(job, target.dateKey);
    if (moved) {
      // moveSchedule gives a start-only block an end equal to its start; keep
      // it start-only rather than inventing a zero-length window.
      const end = job.scheduled_end === null && !job.schedule_daily ? null : moved.scheduled_end;
      if (!sameInstant(moved.scheduled_start, job.scheduled_start) || !sameInstant(end, job.scheduled_end)) {
        dates = { scheduled_start: moved.scheduled_start, scheduled_end: end };
      }
    }
  }

  return crew || dates ? { crew, dates } : null;
}

/**
 * Shift-drop / Shift-paste: ADD the target technician to the crew instead of
 * swapping. Jobs are often done in pairs or more; a plain move swaps the
 * source technician for the target, so building a crew used to mean opening
 * the Schedule dialog. Adding someone never moves the job's dates.
 * Null when there is nothing to add (the Unassigned column, or already on it).
 */
export function planBoardAdd(job: BoardJob, target: BoardCell): BoardMovePlan | null {
  if (!target.staffId || job.crew.includes(target.staffId)) return null;
  return { crew: [...job.crew, target.staffId], dates: null };
}

/** The job as it will look once a plan lands — for the optimistic update. */
export function applyBoardMove(job: BoardJob, plan: BoardMovePlan): BoardJob {
  const next: BoardJob = { ...job };
  if (plan.dates) {
    next.scheduled_start = plan.dates.scheduled_start;
    next.scheduled_end = plan.dates.scheduled_end;
  }
  if (plan.crew) {
    next.crew = plan.crew;
    // The database re-derives the primary (earliest-added assignment); this
    // is only a stand-in until the next load.
    next.assigned_to = job.assigned_to && plan.crew.includes(job.assigned_to) ? job.assigned_to : plan.crew[0] ?? null;
  }
  return next;
}

// ---------------------------------------------------------------------------
// Grid
// ---------------------------------------------------------------------------

/** One job on one booked day. */
export type BoardEntry = {
  job: BoardJob;
  day: ScheduleDay;
  /** 1-based position of `day` among the job's booked days. */
  dayNumber: number;
  dayCount: number;
};

export type BoardIndex = {
  /** staff id → day key → entries, in start-time order. */
  byStaff: Map<string, Map<string, BoardEntry[]>>;
  /** day key → entries with no crew. */
  unassigned: Map<string, BoardEntry[]>;
  /** staff id → day key → booked hours. */
  hours: Map<string, Map<string, number>>;
};

/** Each job's booked days, once — the input buildBoardIndex buckets from. */
export function daysByJob(jobs: readonly BoardJob[]): Map<string, ScheduleDay[]> {
  const days = new Map<string, ScheduleDay[]>();
  for (const job of jobs) days.set(job.id, scheduleDays(job));
  return days;
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V) {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

/**
 * Buckets jobs into the visible days (one day in Day view, seven in Week). A
 * job lands in EVERY crew member's row, on EVERY booked day it occupies — not
 * on its first day under assigned_to alone, which is what the board did before.
 */
export function buildBoardIndex(
  jobs: readonly BoardJob[],
  dayKeys: readonly string[],
  jobDays: ReadonlyMap<string, ScheduleDay[]>,
): BoardIndex {
  const visible = new Set(dayKeys);
  const byStaff = new Map<string, Map<string, BoardEntry[]>>();
  const unassigned = new Map<string, BoardEntry[]>();
  const hours = new Map<string, Map<string, number>>();

  for (const job of jobs) {
    const days = jobDays.get(job.id) ?? scheduleDays(job);
    days.forEach((day, i) => {
      if (!visible.has(day.dateKey)) return;
      const entry: BoardEntry = { job, day, dayNumber: i + 1, dayCount: days.length };
      if (job.crew.length === 0) {
        push(unassigned, day.dateKey, entry);
        return;
      }
      const booked = scheduledHoursOnDay(job, day.dateKey);
      for (const staffId of job.crew) {
        let staffDays = byStaff.get(staffId);
        if (!staffDays) byStaff.set(staffId, (staffDays = new Map()));
        push(staffDays, day.dateKey, entry);
        let staffHours = hours.get(staffId);
        if (!staffHours) hours.set(staffId, (staffHours = new Map()));
        staffHours.set(day.dateKey, (staffHours.get(day.dateKey) ?? 0) + booked);
      }
    });
  }

  const byStart = (a: BoardEntry, b: BoardEntry) => new Date(a.day.startIso).getTime() - new Date(b.day.startIso).getTime();
  for (const list of unassigned.values()) list.sort(byStart);
  for (const staffDays of byStaff.values()) for (const list of staffDays.values()) list.sort(byStart);
  return { byStaff, unassigned, hours };
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

/** "Day 2 of 3" for a job booked on several days; null for a one-day job. */
export function dayOfLabel(entry: Pick<BoardEntry, "dayNumber" | "dayCount">): string | null {
  return entry.dayCount > 1 ? `Day ${entry.dayNumber} of ${entry.dayCount}` : null;
}
