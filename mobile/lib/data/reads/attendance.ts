// "Not attended" on the office Schedule tab (27 Nov 2026; rules in
// lib/bookingAttendance.ts, the web's lib/booking-attendance-data.ts is the
// same read). Online, best-effort like listJobHours: the candidate jobs' WORK
// clock-ons from the window's first day on. IDS AND TIMESTAMPS ONLY —
// time_entries has column grants and a money column (rate_override): a named
// list, never "*". Chunked and paged so the 1000-row cap never drops a
// clock-on (which would call an attended booking missed). null = couldn't
// read; the screen then tags nothing.
import { supabase } from "../../supabase";
import type { AttendanceEntry } from "../../bookingAttendance";
import { chunkIds, mergeResults, readAllPages } from "./pagedRows";
import { unwrapRows, type SupabaseResult } from "./unwrap";

export const ATTENDANCE_ENTRY_COLUMNS = "id, job_id, staff_id, clock_in, entry_type";

type Row = Record<string, unknown>;
interface Query extends PromiseLike<SupabaseResult<Row[]>> {
  select(columns: string): Query;
  in(column: string, values: readonly unknown[]): Query;
  eq(column: string, value: unknown): Query;
  gte(column: string, value: unknown): Query;
  order(column: string): Query;
  range(from: number, to: number): Query;
}
const db = supabase as unknown as { from: (table: string) => Query };

const text = (v: unknown) => (typeof v === "string" ? v : null);

export async function listAttendanceEntries(jobIds: readonly string[], fromIso: string): Promise<AttendanceEntry[] | null> {
  const ids = Array.from(new Set(jobIds));
  if (ids.length === 0) return [];
  try {
    const res = mergeResults(
      await Promise.all(
        chunkIds(ids).map((part) =>
          readAllPages<Row>((from, to) =>
            db
              .from("time_entries")
              .select(ATTENDANCE_ENTRY_COLUMNS)
              .in("job_id", part)
              .eq("entry_type", "work")
              .gte("clock_in", fromIso)
              .order("id")
              .range(from, to)
          )
        )
      )
    );
    return unwrapRows(res, "listAttendanceEntries").map((r) => ({
      job_id: text(r.job_id),
      staff_id: text(r.staff_id),
      clock_in: text(r.clock_in),
      entry_type: text(r.entry_type),
    }));
  } catch (e) {
    console.warn("[schedule] attendance unavailable:", e);
    return null;
  }
}
