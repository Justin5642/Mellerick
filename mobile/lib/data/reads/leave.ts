// Staff leave on the phone's schedule — REMOTE ONLY, by design.
//
// staff_leave is admin-only and deliberately not in the PowerSync publication
// (0039) or any sync stream: the type of someone's leave must never sit in a
// technician's on-device SQLite. The phone asks schedule_leave() (migration
// 0112 — a draft, not applied yet) online, which blanks the type for anyone
// the "who sees the leave type" setting excludes. Offline, or before 0112 is
// applied, this returns [] and the schedule simply shows no leave — the
// bookings themselves are unaffected.
//
// The rules (days, hours, clashes) are lib/staffLeave.ts, the mirror of the web's.
import { supabase } from "../../supabase";
import { isLeaveSourceMissing, type ScheduleLeave } from "../../staffLeave";

/** The furthest apart from/to schedule_leave() accepts. */
export const MAX_LEAVE_RANGE_DAYS = 400;

export type LeaveResult = { leave: ScheduleLeave[]; available: boolean };

function toLeave(row: Record<string, unknown>): ScheduleLeave {
  return {
    id: (row.id as string | null) ?? null,
    staff_id: String(row.staff_id),
    start_date: String(row.start_date),
    end_date: String(row.end_date),
    hours: row.hours == null ? null : Number(row.hours),
    start_time: (row.start_time as string | null) ?? null,
    end_time: (row.end_time as string | null) ?? null,
    leave_type: (row.leave_type as string | null) ?? null,
  };
}

/**
 * Leave overlapping [fromKey, toKey]. `available` is false when it could not
 * be read (offline, or 0112 not applied) — the caller may say "leave not
 * shown" rather than imply nobody is off.
 */
export async function listScheduleLeave(fromKey: string, toKey: string): Promise<LeaveResult> {
  try {
    const { data, error } = await (supabase as unknown as {
      rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { code?: string; message?: string } | null }>;
    }).rpc("schedule_leave", { p_from: fromKey, p_to: toKey });
    if (error) {
      if (!isLeaveSourceMissing(error)) console.warn("[leave] schedule leave unavailable:", error.message);
      return { leave: [], available: false };
    }
    return { leave: ((data as Record<string, unknown>[] | null) ?? []).map(toLeave), available: true };
  } catch (e) {
    console.warn("[leave] schedule leave unavailable:", e instanceof Error ? e.message : e);
    return { leave: [], available: false };
  }
}
