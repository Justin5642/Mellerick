import { describe, it, expect } from "vitest";
import { ACTUAL_ENTRY_COLUMNS, ATTENDANCE_ENTRY_COLUMNS, loadActualEntries, loadAttendanceEntries, type AttendanceClient } from "@/lib/booking-attendance-data";

// "Not attended" reads time_entries (27 Nov 2026). time_entries carries a money
// column (rate_override) behind column grants (0045): a named list of ids and
// timestamps only, chunked, paged, and a failed read answers null (no tags)
// rather than calling attended bookings missed.

type Call = { table: string; columns: string; filters: string[] };

function client(pages: (call: Call, from: number) => { data: unknown[] | null; error: { message: string } | null }) {
  const calls: Call[] = [];
  const c: AttendanceClient = {
    from: (table) => ({
      select: (columns) => {
        const call: Call = { table, columns, filters: [] };
        calls.push(call);
        const q = {
          in: (col: string, vals: readonly string[]) => (call.filters.push(`in:${col}:${vals.length}`), q),
          eq: (col: string, v: string) => (call.filters.push(`eq:${col}:${v}`), q),
          gte: (col: string, v: string) => (call.filters.push(`gte:${col}:${v}`), q),
          lt: (col: string, v: string) => (call.filters.push(`lt:${col}:${v}`), q),
          order: () => q,
          range: async (from: number) => ({ ...pages(call, from), count: null }),
        };
        return q as never;
      },
    }),
  };
  return { c, calls };
}

describe("loadAttendanceEntries", () => {
  it("selects ids and timestamps only — never a rate", () => {
    expect(ATTENDANCE_ENTRY_COLUMNS).not.toMatch(/rate|amount|cost|\*/);
    expect(ATTENDANCE_ENTRY_COLUMNS.split(", ").sort()).toEqual(["clock_in", "entry_type", "id", "job_id", "staff_id"]);
  });

  it("reads work entries from the window's start, 100 job ids per request", async () => {
    const ids = Array.from({ length: 150 }, (_, i) => `job-${i}`);
    const { c, calls } = client(() => ({ data: [{ id: "e", job_id: "job-1", staff_id: "t", clock_in: "2026-11-23T00:00:00Z", entry_type: "work" }], error: null }));
    const rows = await loadAttendanceEntries(c, ids, "2026-09-27T14:00:00.000Z");
    expect(calls.map((x) => x.filters)).toEqual([
      ["in:job_id:100", "eq:entry_type:work", "gte:clock_in:2026-09-27T14:00:00.000Z"],
      ["in:job_id:50", "eq:entry_type:work", "gte:clock_in:2026-09-27T14:00:00.000Z"],
    ]);
    expect(calls.every((x) => x.table === "time_entries")).toBe(true);
    expect(rows).toHaveLength(2);
  });

  it("answers null when a read fails", async () => {
    const { c } = client(() => ({ data: null, error: { message: "boom" } }));
    expect(await loadAttendanceEntries(c, ["job-1"], "x")).toBeNull();
  });

  it("asks nothing for no jobs", async () => {
    const { c, calls } = client(() => ({ data: [], error: null }));
    expect(await loadAttendanceEntries(c, [], "x")).toEqual([]);
    expect(calls).toHaveLength(0);
  });
});

describe("loadActualEntries (actual clocked time on the schedule)", () => {
  it("selects ids and timestamps only — never a rate", () => {
    expect(ACTUAL_ENTRY_COLUMNS).not.toMatch(/rate|amount|cost|hours|\*/);
    expect(ACTUAL_ENTRY_COLUMNS.split(", ").sort()).toEqual(["clock_in", "clock_out", "entry_type", "id", "job_id", "staff_id"]);
  });

  it("reads every work entry clocked on in the board's range", async () => {
    const { c, calls } = client(() => ({ data: [{ id: "e" }], error: null }));
    const rows = await loadActualEntries(c, "2026-09-27T14:00:00.000Z", "2026-11-27T01:00:00.000Z");
    expect(rows).toHaveLength(1);
    expect(calls[0].table).toBe("time_entries");
    expect(calls[0].columns).toBe(ACTUAL_ENTRY_COLUMNS);
    expect(calls[0].filters).toEqual(["eq:entry_type:work", "gte:clock_in:2026-09-27T14:00:00.000Z", "lt:clock_in:2026-11-27T01:00:00.000Z"]);
  });

  it("answers null when the read fails", async () => {
    const { c } = client(() => ({ data: null, error: { message: "boom" } }));
    expect(await loadActualEntries(c, "a", "b")).toBeNull();
  });
});
