// "Not attended" read (0121): time_entries, ids and timestamps only, chunked
// and paged; a failure answers null (no tags) rather than a partial list.
type Call = [string, ...unknown[]];
const calls: { table: string; chain: Call[] }[] = [];
let rows: Record<string, unknown>[] = [];
let fail = false;

function mockBuilder(table: string) {
  const chain: Call[] = [];
  calls.push({ table, chain });
  let range: [number, number] = [0, 999];
  const b: Record<string, unknown> = {};
  for (const m of ["select", "in", "eq", "gte", "lt", "order"]) {
    b[m] = (...a: unknown[]) => (chain.push([m, ...(m === "in" ? [a[0], (a[1] as unknown[]).length] : a)]), b);
  }
  b.range = (from: number, to: number) => {
    range = [from, to];
    return b;
  };
  b.then = (resolve: (v: unknown) => void) =>
    Promise.resolve(fail ? { data: null, error: { message: "boom" } } : { data: rows.slice(range[0], range[1] + 1), error: null }).then(resolve);
  return b;
}
jest.mock("../../supabase", () => ({ supabase: { from: (t: string) => mockBuilder(t) } }));

import { ACTUAL_ENTRY_COLUMNS, ATTENDANCE_ENTRY_COLUMNS, listActualEntries, listActualJobLabels, listAttendanceEntries } from "./attendance";

beforeEach(() => {
  calls.length = 0;
  rows = [];
  fail = false;
});

it("selects ids and timestamps only — never a rate", () => {
  expect(ATTENDANCE_ENTRY_COLUMNS).not.toMatch(/rate|amount|cost|\*/);
});

it("reads work clock-ons from the window, 100 jobs per request", async () => {
  rows = [{ id: "e1", job_id: "j1", staff_id: "t", clock_in: "2026-11-23T00:00:00Z", entry_type: "work", rate_override: 99 }];
  const ids = Array.from({ length: 150 }, (_, i) => `j${i}`);
  const out = await listAttendanceEntries(ids, "2026-09-27T14:00:00Z");
  expect(calls).toHaveLength(2);
  expect(calls[0].chain).toEqual(
    expect.arrayContaining([
      ["select", ATTENDANCE_ENTRY_COLUMNS],
      ["in", "job_id", 100],
      ["eq", "entry_type", "work"],
      ["gte", "clock_in", "2026-09-27T14:00:00Z"],
    ])
  );
  expect(out?.[0]).toEqual({ job_id: "j1", staff_id: "t", clock_in: "2026-11-23T00:00:00Z", entry_type: "work" });
});

it("null on a failed read; [] for no jobs", async () => {
  fail = true;
  expect(await listAttendanceEntries(["j1"], "x")).toBeNull();
  expect(await listAttendanceEntries([], "x")).toEqual([]);
});

describe("listActualEntries (clocked time on the Schedule tab)", () => {
  it("selects ids and timestamps only — never a rate", () => {
    expect(ACTUAL_ENTRY_COLUMNS).not.toMatch(/rate|amount|cost|hours|\*/);
    expect(ACTUAL_ENTRY_COLUMNS.split(", ").sort()).toEqual(["clock_in", "clock_out", "entry_type", "id", "job_id", "staff_id"]);
  });

  it("reads work entries clocked on in the days shown, and drops anything else in a row", async () => {
    rows = [{ id: "e1", job_id: "j1", staff_id: "t", clock_in: "2026-11-23T00:00:00Z", clock_out: null, entry_type: "work", rate_override: 99 }];
    const out = await listActualEntries("2026-11-22T13:00:00Z", "2026-11-27T01:00:00Z");
    expect(calls[0].table).toBe("time_entries");
    expect(calls[0].chain).toEqual(
      expect.arrayContaining([
        ["select", ACTUAL_ENTRY_COLUMNS],
        ["eq", "entry_type", "work"],
        ["gte", "clock_in", "2026-11-22T13:00:00Z"],
        ["lt", "clock_in", "2026-11-27T01:00:00Z"],
      ])
    );
    expect(out).toEqual([{ id: "e1", job_id: "j1", staff_id: "t", clock_in: "2026-11-23T00:00:00Z", clock_out: null, entry_type: "work" }]);
  });

  it("null on a failed read; nothing asked for a future range", async () => {
    fail = true;
    expect(await listActualEntries("a", "b")).toBeNull();
    calls.length = 0;
    expect(await listActualEntries("2026-12-01T00:00:00Z", "2026-11-27T00:00:00Z")).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it("reads job numbers and titles only", async () => {
    rows = [{ id: "j9", job_number: 123, title: "Sewer" }];
    const out = await listActualJobLabels(["j9"]);
    expect(calls[0].chain[0]).toEqual(["select", "id, job_number, title"]);
    expect(out.get("j9")).toEqual({ job_number: 123, title: "Sewer" });
  });
});
