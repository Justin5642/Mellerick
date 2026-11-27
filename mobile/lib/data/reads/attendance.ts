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
import type { ActualEntry } from "../../scheduleActuals";
import { chunkIds, mergeResults, readAllPages } from "./pagedRows";
import { unwrapRows, type SupabaseResult } from "./unwrap";

export const ATTENDANCE_ENTRY_COLUMNS = "id, job_id, staff_id, clock_in, entry_type";

type Row = Record<string, unknown>;
interface Query extends PromiseLike<SupabaseResult<Row[]>> {
  select(columns: string): Query;
  in(column: string, values: readonly unknown[]): Query;
  eq(column: string, value: unknown): Query;
  gte(column: string, value: unknown): Query;
  lt(column: string, value: unknown): Query;
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

// ---------------------------------------------------------------------------
// Actual clocked time on the office Schedule tab (27 Nov 2026; rules in
// lib/scheduleActuals.ts, the web's loadActualEntries is the same read).
// Every WORK entry clocked on in the days shown — for every technician, so
// time on a job they weren't booked on shows too. Online, best-effort; IDS AND
// TIMESTAMPS ONLY (never "*", never rate_override). null = couldn't read; the
// grid then draws no clocked time.
// ---------------------------------------------------------------------------

export const ACTUAL_ENTRY_COLUMNS = "id, job_id, staff_id, clock_in, clock_out, entry_type";

export async function listActualEntries(fromIso: string, toIso: string): Promise<ActualEntry[] | null> {
  if (toIso <= fromIso) return [];
  try {
    const res = await readAllPages<Row>((from, to) =>
      db
        .from("time_entries")
        .select(ACTUAL_ENTRY_COLUMNS)
        .eq("entry_type", "work")
        .gte("clock_in", fromIso)
        .lt("clock_in", toIso)
        .order("id")
        .range(from, to)
    );
    return unwrapRows(res, "listActualEntries").flatMap((r) =>
      typeof r.id === "string"
        ? [
            {
              id: r.id,
              job_id: text(r.job_id),
              staff_id: text(r.staff_id),
              clock_in: text(r.clock_in),
              clock_out: text(r.clock_out),
              entry_type: text(r.entry_type),
            },
          ]
        : []
    );
  } catch (e) {
    console.warn("[schedule] clocked time unavailable:", e);
    return null;
  }
}

/** Number and title of the jobs an unbooked span is on but the grid doesn't hold. Best-effort. */
export async function listActualJobLabels(jobIds: readonly string[]): Promise<Map<string, { job_number: number | null; title: string | null }>> {
  const out = new Map<string, { job_number: number | null; title: string | null }>();
  const ids = Array.from(new Set(jobIds));
  if (ids.length === 0) return out;
  try {
    for (const part of chunkIds(ids)) {
      const res = await db.from("jobs").select("id, job_number, title").in("id", part);
      for (const r of unwrapRows(res, "listActualJobLabels")) {
        if (typeof r.id !== "string") continue;
        out.set(r.id, { job_number: typeof r.job_number === "number" ? r.job_number : null, title: text(r.title) });
      }
    }
  } catch (e) {
    console.warn("[schedule] clocked-time job labels unavailable:", e);
  }
  return out;
}
