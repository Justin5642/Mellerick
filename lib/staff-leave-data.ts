// Reads for leave on the schedule (web). The rules live in lib/staff-leave.ts;
// this file only fetches. Everything goes through schedule_leave() (0112 — a draft, not applied yet),
// which decides in the database whether the caller may see the leave TYPE —
// a technician gets NULL there, so no UI check is the only thing hiding it.
//
// Before 0112 is applied the function does not exist: every reader here
// returns [] (no leave on the schedule) instead of an error.
import { isLeaveSourceMissing, DEFAULT_LEAVE_TYPE_AUDIENCE, type LeaveTypeAudience, type ScheduleLeave } from "@/lib/staff-leave";
import { dateKeyInBusinessTZ, shiftDateKey } from "@/lib/date";

type RpcError = { code?: string | null; message?: string | null } | null;
/** Narrowed to what this file calls, so any Supabase client (server, browser, caller) fits. */
export type LeaveReadClient = {
  rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: RpcError }>;
};
export type LeaveSettingsClient = {
  from: (table: string) => {
    select: (columns: string) => { maybeSingle: () => PromiseLike<{ data: unknown; error: RpcError }> };
  };
};

/** The furthest apart from/to schedule_leave() accepts. */
export const MAX_LEAVE_RANGE_DAYS = 400;

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
 * Leave overlapping [fromKey, toKey] (Melbourne "YYYY-MM-DD"). [] before 0112;
 * any other failure is logged and also shows no leave — the schedule must
 * never go down because leave couldn't be read.
 */
export async function loadScheduleLeave(client: unknown, fromKey: string, toKey: string): Promise<ScheduleLeave[]> {
  // Any Supabase client; schedule_leave is not in the generated types until they are regenerated after 0112.
  const supabase = client as LeaveReadClient;
  let to = toKey;
  if (shiftDateKey(fromKey, MAX_LEAVE_RANGE_DAYS) < to) to = shiftDateKey(fromKey, MAX_LEAVE_RANGE_DAYS);
  try {
    const { data, error } = await supabase.rpc("schedule_leave", { p_from: fromKey, p_to: to });
    if (error) {
      if (!isLeaveSourceMissing(error)) console.error("schedule leave unavailable:", error.message);
      return [];
    }
    return ((data as Record<string, unknown>[] | null) ?? []).map(toLeave);
  } catch (e) {
    console.error("schedule leave unavailable:", e instanceof Error ? e.message : e);
    return [];
  }
}

/** The board's window: two months back, ten months ahead (the board steps weeks client-side). */
export function boardLeaveRange(now = new Date()): { from: string; to: string } {
  const today = dateKeyInBusinessTZ(now);
  return { from: shiftDateKey(today, -60), to: shiftDateKey(today, 300) };
}

/** Who sees the leave type (0112); the default when the setting can't be read. */
export async function loadLeaveTypeAudience(client: unknown): Promise<{ audience: LeaveTypeAudience; available: boolean }> {
  try {
    const supabase = client as LeaveSettingsClient;
    const { data, error } = await supabase.from("schedule_settings").select("leave_type_visible_to").maybeSingle();
    if (error || !data) return { audience: DEFAULT_LEAVE_TYPE_AUDIENCE, available: !error };
    const v = (data as { leave_type_visible_to?: string }).leave_type_visible_to;
    return { audience: v === "admin" || v === "everyone" ? v : "office_admin", available: true };
  } catch {
    return { audience: DEFAULT_LEAVE_TYPE_AUDIENCE, available: false };
  }
}
