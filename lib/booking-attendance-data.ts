import { fetchAllRows, type RangeableQuery } from "@/lib/fetch-all-rows";
import type { AttendanceEntry } from "@/lib/booking-attendance";

/**
 * The one read behind "Not attended" on the schedule board (lib/booking-
 * attendance.ts; Justin, 27 Nov 2026): each candidate job's WORK clock-ons
 * from the board's first day on. Run as the CALLER — the board only asks for
 * an office/admin viewer — so RLS decides, never the service role.
 *
 * IDS AND TIMESTAMPS ONLY. time_entries has column-level grants (0045) and a
 * money column (rate_override): a named list, never "*". `.in()` in chunks of
 * 100 so the URL stays short; every chunk paged (lib/fetch-all-rows.ts) so
 * PostgREST's 1000-row cap never silently drops a clock-on — which would show
 * a booking as not attended when it was.
 */

export const ATTENDANCE_ENTRY_COLUMNS = "id, job_id, staff_id, clock_in, entry_type";
export const ATTENDANCE_CHUNK = 100;

type Filterable<T> = RangeableQuery<T> & {
  in: (column: string, values: readonly string[]) => Filterable<T>;
  eq: (column: string, value: string) => Filterable<T>;
  gte: (column: string, value: string) => Filterable<T>;
  order: (column: string, opts?: { ascending?: boolean }) => Filterable<T>;
};

/** The one method used, narrowed (the generic typed client trips TS2589 on a structural match). */
export type AttendanceClient = {
  from: (table: string) => { select: (columns: string, opts?: { count?: "exact" }) => Filterable<unknown> };
};

/**
 * Work entries on these jobs clocked on at or after `fromIso`, or null when
 * any read failed — the board then shows no "Not attended" tags rather than
 * calling attended bookings missed.
 */
export async function loadAttendanceEntries(
  client: AttendanceClient,
  jobIds: readonly string[],
  fromIso: string,
): Promise<AttendanceEntry[] | null> {
  const ids = Array.from(new Set(jobIds));
  if (ids.length === 0) return [];
  const parts: string[][] = [];
  for (let i = 0; i < ids.length; i += ATTENDANCE_CHUNK) parts.push(ids.slice(i, i + ATTENDANCE_CHUNK));
  try {
    const results = await Promise.all(
      parts.map((part) =>
        fetchAllRows<unknown>((count) =>
          client
            .from("time_entries")
            .select(ATTENDANCE_ENTRY_COLUMNS, count)
            .in("job_id", part)
            .eq("entry_type", "work")
            .gte("clock_in", fromIso)
            .order("id"),
        ),
      ),
    );
    const rows: AttendanceEntry[] = [];
    for (const r of results) {
      if (!r.ok) throw new Error(`attendance time_entries: ${r.error}`);
      rows.push(...(r.rows as AttendanceEntry[]));
    }
    return rows;
  } catch (e) {
    console.error("[schedule] attendance unavailable:", e instanceof Error ? e.message : e);
    return null;
  }
}
