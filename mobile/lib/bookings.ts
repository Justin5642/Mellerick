// Per-technician job bookings (migration 0079 yet), as
// pure rules. No I/O: reads live in lib/data/reads/bookings.ts, writes in
// ScheduleRepository.
//
// A booking is one technician's (or nobody's — staff_id null) window on a job,
// with its own cost centre. Its window has exactly the shape of the job-level
// schedule (0071: start/end, `daily` = the same hours on each booked weekday),
// so every day rule in ./scheduling.ts applies to it unchanged through
// bookingWindow(). That is deliberate: a booking that disagreed with the board
// about which days it books would be worse than no bookings at all.
//
// Until 0079 is applied there are no bookings anywhere, and every screen falls
// back to the job-level window. Those fallbacks are encoded here too, so the
// screens cannot each invent their own.
import { dateKeyInBusinessTZ } from "./date";
import { scheduleDays, type ScheduleColumns, type ScheduledJobWindow } from "./scheduling";

export interface Booking {
  id: string;
  job_id: string;
  /** null = an unassigned booking (the board's Unassigned row). */
  staff_id: string | null;
  cost_center_id: string | null;
  starts_at: string;
  ends_at: string | null;
  daily: boolean;
  all_day: boolean;
}

/** The parts of a booking the clock-in needs, small enough to hand to the background task. */
export type BookingWindow = Pick<Booking, "starts_at" | "ends_at" | "daily" | "cost_center_id">;

/** A booking's window in the job-schedule shape every ./scheduling.ts rule takes. */
export function bookingWindow(b: Pick<Booking, "starts_at" | "ends_at" | "daily"> & { all_day?: boolean }): ScheduledJobWindow & {
  scheduled_start: string;
  schedule_daily: boolean;
  schedule_all_day: boolean;
} {
  return {
    scheduled_start: b.starts_at,
    scheduled_end: b.ends_at,
    schedule_daily: b.daily,
    schedule_all_day: !!b.all_day,
  };
}

/**
 * A window to write: buildScheduleColumns() output, or a moved window
 * (moveSchedule / computeRescheduleWithTime), whose end may be absent.
 */
export type BookingWindowColumns = Omit<ScheduleColumns, "scheduled_end"> & { scheduled_end: string | null };

/** A window as booking columns — one window, written per technician. */
export function bookingColumns(columns: BookingWindowColumns): Pick<Booking, "starts_at" | "ends_at" | "daily" | "all_day"> {
  return {
    starts_at: columns.scheduled_start,
    ends_at: columns.scheduled_end,
    daily: columns.schedule_daily,
    all_day: columns.schedule_all_day,
  };
}

// ---------------------------------------------------------------------------
// My Jobs
// ---------------------------------------------------------------------------

/** What My Jobs needs of a job to place it. */
export interface MyJobWindow extends ScheduledJobWindow {
  id: string;
}

/** One My Jobs card: a job, at one of the technician's bookings or (fallback) the job's own window. */
export interface MyJobEntry<J extends MyJobWindow> {
  key: string;
  job: J;
  window: ScheduledJobWindow;
  /** The booking's cost centre; null for a job-level entry (the job screen shows that). */
  costCenterId: string | null;
  /** Null when this entry is the job-level fallback. */
  bookingId: string | null;
}

/**
 * The technician's My Jobs entries: one per OWN booking — a job booked twice
 * for them is two cards, each with its own time and cost centre — instead of
 * one card spanning the whole crew's window.
 *
 * Falls back to the job's own window when:
 *   - `bookings` is null (the table does not exist yet, or could not be read);
 *   - the job has no booking for this technician. That covers old data, an
 *     unscheduled job, and a crew member the office has not booked yet (0079
 *     lets someone join a crew whose bookings differ without a booking of
 *     their own). Hiding the job would be worse: they are on it.
 *
 * Bookings that finished before today are dropped while the technician has a
 * current one on the same job — Monday's rough-in should not sit in Upcoming
 * on Wednesday when Thursday's fit-off is the next visit. If every booking is
 * past, the latest stays, so an open job never vanishes from the list (the
 * job-level card behaved the same way).
 */
export function myJobEntries<J extends MyJobWindow>(
  jobs: J[],
  bookings: Booking[] | null,
  staffId: string,
  todayKey: string
): MyJobEntry<J>[] {
  const mineByJob = new Map<string, Booking[]>();
  for (const b of bookings ?? []) {
    if (b.staff_id !== staffId) continue;
    const list = mineByJob.get(b.job_id);
    if (list) list.push(b);
    else mineByJob.set(b.job_id, [b]);
  }

  const out: MyJobEntry<J>[] = [];
  for (const job of jobs) {
    const mine = mineByJob.get(job.id);
    if (!mine || mine.length === 0) {
      out.push({
        key: job.id,
        job,
        window: { scheduled_start: job.scheduled_start, scheduled_end: job.scheduled_end, schedule_daily: job.schedule_daily },
        costCenterId: null,
        bookingId: null,
      });
      continue;
    }
    const lastDay = (b: Booking) => {
      const days = scheduleDays(bookingWindow(b));
      return days.length ? days[days.length - 1].dateKey : dateKeyInBusinessTZ(b.starts_at);
    };
    const current = mine.filter((b) => lastDay(b) >= todayKey);
    const keep = current.length > 0 ? current : [mine.reduce((a, b) => (b.starts_at > a.starts_at ? b : a))];
    for (const b of keep) {
      out.push({ key: `${job.id}:${b.id}`, job, window: bookingWindow(b), costCenterId: b.cost_center_id, bookingId: b.id });
    }
  }
  return out;
}

/** The entry's block on `dateKey`, or null when it does not book that day. */
function dayOn(window: ScheduledJobWindow, dateKey: string) {
  return scheduleDays(window).find((d) => d.dateKey === dateKey) ?? null;
}

/**
 * Today / Upcoming, by the ENTRY's own time (a booking's window, not the
 * job's). Today is every entry that books today, in that day's start order;
 * Upcoming is the rest, soonest first, unscheduled last — the order the
 * job-level list had from its SQL.
 */
export function splitMyJobEntries<J extends MyJobWindow>(
  entries: MyJobEntry<J>[],
  todayKey: string
): { today: MyJobEntry<J>[]; upcoming: MyJobEntry<J>[] } {
  const today: { e: MyJobEntry<J>; start: string }[] = [];
  const upcoming: MyJobEntry<J>[] = [];
  for (const e of entries) {
    const d = dayOn(e.window, todayKey);
    if (d) today.push({ e, start: d.startIso });
    else upcoming.push(e);
  }
  today.sort((a, b) => a.start.localeCompare(b.start));
  const startOf = (e: MyJobEntry<J>) => e.window.scheduled_start;
  // Stable sort: ties keep the incoming (SQL) order.
  const sortedUpcoming = upcoming
    .map((e, i) => ({ e, i }))
    .sort((a, b) => {
      const sa = startOf(a.e);
      const sb = startOf(b.e);
      if (sa && sb && sa !== sb) return sa.localeCompare(sb);
      if (!sa !== !sb) return sa ? -1 : 1;
      return a.i - b.i;
    })
    .map((x) => x.e);
  return { today: today.map((x) => x.e), upcoming: sortedUpcoming };
}

// ---------------------------------------------------------------------------
// Clock-in cost centre
// ---------------------------------------------------------------------------

function msOf(iso: string): number {
  return new Date(iso).getTime();
}

/**
 * The booking a clock-in at `atMs` belongs to, among ONE technician's
 * bookings on ONE job:
 *   1. the booking whose block covers that instant (a daily booking covers
 *      only its hours on each booked day, never the night between);
 *   2. otherwise the booking with a block that day (Melbourne) nearest to it
 *      — arriving at 6:40 for a 7:00 start, or staying past 15:30;
 *   3. otherwise none.
 */
export function bookingAt<B extends BookingWindow>(bookings: B[], atMs: number): B | null {
  const dateKey = dateKeyInBusinessTZ(new Date(atMs));
  let nearest: { b: B; distance: number } | null = null;
  for (const b of bookings) {
    const block = dayOn(bookingWindow(b), dateKey);
    if (!block) continue;
    const start = msOf(block.startIso);
    const end = msOf(block.endIso);
    if (atMs >= start && atMs < end) return b;
    const distance = atMs < start ? start - atMs : atMs - end;
    if (!nearest || distance < nearest.distance) nearest = { b, distance };
  }
  return nearest?.b ?? null;
}

/**
 * The cost centre a new time entry defaults to (manual clock-in and the
 * geofence auto clock-in alike): the technician's booking covering the
 * clock-in, else their nearest booking that day, else the job-level
 * scheduled_cost_center_id — which is all there was before 0079, and is still
 * what an older device or an unbooked crew member gets.
 *
 * A chosen booking with no cost centre falls through to the job level. Under
 * 0079 the job level is set only when every booking agrees, so that is null
 * too whenever it matters; it only differs on data from before bookings.
 */
export function clockInCostCentre(
  myBookings: BookingWindow[] | null | undefined,
  atMs: number,
  jobLevelCostCentreId: string | null | undefined
): string | null {
  const chosen = myBookings && myBookings.length ? bookingAt(myBookings, atMs) : null;
  return chosen?.cost_center_id ?? jobLevelCostCentreId ?? null;
}

// ---------------------------------------------------------------------------
// Offline edits
// ---------------------------------------------------------------------------

/**
 * Merge a fresh read of a job's bookings with what the screen shows, keeping
 * edits still waiting in the outbox. The device mirror only learns about a
 * booking once its write has reached the server and come back down, so a
 * reload offline would otherwise undo the office's edits on screen:
 *   - pending insert/update: the screen's version wins;
 *   - pending delete (on screen: gone; in the read: still there): stays gone.
 * Anything not pending: the read wins. Sorted by start, as the reads are.
 */
export function mergePendingBookings<B extends Pick<Booking, "id" | "starts_at">>(
  shown: B[],
  read: B[],
  pendingIds: Set<string>
): B[] {
  const shownById = new Map(shown.map((b) => [b.id, b]));
  const out: B[] = [];
  const seen = new Set<string>();
  for (const b of read) {
    seen.add(b.id);
    if (!pendingIds.has(b.id)) out.push(b);
    else if (shownById.has(b.id)) out.push(shownById.get(b.id)!);
    // pending and not shown → a queued delete; leave it out.
  }
  for (const b of shown) {
    if (!seen.has(b.id) && pendingIds.has(b.id)) out.push(b); // queued insert
  }
  return out.sort((a, b) => a.starts_at.localeCompare(b.starts_at));
}
