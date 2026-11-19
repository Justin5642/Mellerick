// The leave warning in the Schedule tab's crew picker (Reassign technician).
//
// Ticking a technician into a job's crew books them through the database
// (0079's job_assignments_to_bookings): when the job's bookings share ONE
// window the newcomer gets a booking on it; when they differ the newcomer
// joins the crew with no booking (the office books them separately). Before
// 0079 the crew simply shares the job's own window. This works out that
// window and whether it puts the technician on their leave, with the
// mirrored day rules (lib/staffLeave.ts) — the same check a board move or the
// Add booking sheet already makes. Leave is read online only, so offline the
// list is empty and nothing warns, as everywhere else on the phone.
import { bookingLeaveConflicts, leaveDateLabel, leaveDayLabel, type LeaveCheckBooking, type LeaveConflict, type ScheduleLeave } from "./staffLeave";
import type { Booking } from "./bookings";

export type CrewWindow = Omit<LeaveCheckBooking, "staff_id">;

function instant(iso: string | null): string {
  if (iso === null) return "";
  const t = Date.parse(iso);
  return Number.isFinite(t) ? String(t) : iso;
}

/**
 * The window a technician newly added to the crew is booked on, or null when
 * they would get no booking. `jobBookings` is null before 0079 (bookings not
 * readable): the job-level window is the crew's.
 */
export function crewJoinWindow(
  jobBookings: readonly Pick<Booking, "starts_at" | "ends_at" | "daily" | "all_day" | "cost_center_id">[] | null,
  job: { scheduled_start: string | null; scheduled_end: string | null; schedule_daily?: boolean | null },
): CrewWindow | null {
  if (jobBookings === null) {
    return job.scheduled_start ? { starts_at: job.scheduled_start, ends_at: job.scheduled_end, daily: !!job.schedule_daily } : null;
  }
  // 0079 counts distinct (starts_at, ends_at, daily, all_day, cost_center_id).
  const windows = new Map<string, (typeof jobBookings)[number]>();
  for (const b of jobBookings) windows.set([instant(b.starts_at), instant(b.ends_at), b.daily, b.all_day, b.cost_center_id ?? ""].join("|"), b);
  if (windows.size !== 1) return null;
  const only = [...windows.values()][0];
  return { starts_at: only.starts_at, ends_at: only.ends_at, daily: only.daily };
}

/** The leave days (today on) the crew window would book this technician onto. */
export function crewLeaveConflicts(staffId: string, window: CrewWindow | null, leave: readonly ScheduleLeave[], todayKey: string): LeaveConflict[] {
  if (!window || leave.length === 0) return [];
  return bookingLeaveConflicts({ ...window, staff_id: staffId }, leave, todayKey);
}

/**
 * "Dave isn't available then — Sick Tue 18 Nov, Sick · 4 h Wed 19 Nov." The
 * label is "Unavailable" when the server withheld the leave type (0112's
 * "who sees the leave type" setting).
 */
export function describeCrewLeave(name: string, conflicts: readonly LeaveConflict[], max = 4): string {
  const parts = conflicts.slice(0, max).map((c) => `${leaveDayLabel(c.leaveDay)} ${leaveDateLabel(c.dateKey)}`);
  const more = conflicts.length > max ? ` and ${conflicts.length - max} more day${conflicts.length - max === 1 ? "" : "s"}` : "";
  return `${name} isn't available then — ${parts.join(", ")}${more}.`;
}
