// Hours scoreboard reads: local and remote must return IDENTICAL shapes, the
// technician's local time entries must reproduce the RLS own-rows filter, and
// technicians never read purchase orders locally (they do not sync them).
const mockCalls: { table: string; chain: [string, unknown[]][] }[] = [];
const mockResponses: Record<string, unknown> = {};
jest.mock("../../supabase", () => ({
  supabase: {
    from: (table: string) => {
      const entry = { table, chain: [] as [string, unknown[]][] };
      mockCalls.push(entry);
      const builder: Record<string, unknown> = {};
      for (const m of ["select", "eq", "order"]) {
        builder[m] = (...args: unknown[]) => {
          entry.chain.push([m, args]);
          return builder;
        };
      }
      builder.then = (resolve: (v: unknown) => unknown) => resolve(mockResponses[table] ?? { data: [], error: null });
      return builder;
    },
  },
}));

import { resetSourceForTests, setLocalReads, type LocalReads, type LocalRole } from "./source";
import {
  getJobAllocatedHours,
  listJobWorkTimeEntries,
  SQL_JOB_IN_MIRROR,
  SQL_JOB_PO_HOURS,
  SQL_JOB_WORK_ENTRIES_ALL,
  SQL_JOB_WORK_ENTRIES_OWN,
  type WorkTimeEntry,
} from "./hoursScoreboard";

const MONEY = /\b(rate|rate_override|total_value|amount|cost|price|total_amount)\b/i;

function fakeReads(role: LocalRole, sqlRows: Record<string, unknown[]>, inMirror = true): LocalReads & { getAll: jest.Mock } {
  return {
    hasSynced: () => true,
    role: () => role,
    getAll: jest.fn(async (sql: string) => sqlRows[sql] ?? []),
    getOptional: jest.fn(async (sql: string) => (sql === SQL_JOB_IN_MIRROR && inMirror ? { id: "job-1" } : null)),
  } as LocalReads & { getAll: jest.Mock };
}

// The same three entries, as SQLite returns them and as PostgREST does.
const SQLITE_ENTRIES = [
  { hours: 2.5, clock_in: "2026-10-09T00:00:00Z", clock_out: "2026-10-09T02:30:00Z" },
  { hours: "1.25", clock_in: "2026-10-08T00:00:00Z", clock_out: "2026-10-08T01:15:00Z" },
  { hours: null, clock_in: "2026-10-09T03:00:00Z", clock_out: null },
];
const POSTGREST_ENTRIES = [
  { hours: 2.5, clock_in: "2026-10-09T00:00:00Z", clock_out: "2026-10-09T02:30:00Z" },
  { hours: 1.25, clock_in: "2026-10-08T00:00:00Z", clock_out: "2026-10-08T01:15:00Z" },
  { hours: null, clock_in: "2026-10-09T03:00:00Z", clock_out: null },
];
const EXPECTED: WorkTimeEntry[] = POSTGREST_ENTRIES;

afterEach(() => {
  resetSourceForTests();
  mockCalls.length = 0;
  for (const k of Object.keys(mockResponses)) delete mockResponses[k];
});

describe("listJobWorkTimeEntries", () => {
  it("local (office) and remote return identical shapes", async () => {
    setLocalReads(fakeReads("office", { [SQL_JOB_WORK_ENTRIES_ALL]: SQLITE_ENTRIES }));
    const local = await listJobWorkTimeEntries("job-1", "u1");
    expect(mockCalls).toHaveLength(0);

    resetSourceForTests();
    mockResponses.time_entries = { data: POSTGREST_ENTRIES, error: null };
    const remote = await listJobWorkTimeEntries("job-1", "u1");

    expect(local).toEqual(EXPECTED);
    expect(remote).toEqual(EXPECTED);
  });

  it("a technician reads ONLY their own entries locally — the rows RLS gives them remotely", async () => {
    const db = fakeReads("technician", { [SQL_JOB_WORK_ENTRIES_OWN]: SQLITE_ENTRIES });
    setLocalReads(db);
    await listJobWorkTimeEntries("job-1", "tech-7");
    const [sql, params] = db.getAll.mock.calls[0];
    expect(sql).toBe(SQL_JOB_WORK_ENTRIES_OWN);
    expect(sql).toMatch(/staff_id = \?/);
    expect(params).toEqual(["job-1", "tech-7"]);
    expect(mockCalls).toHaveLength(0);
  });

  it("a technician with no known user id goes remote rather than guess", async () => {
    setLocalReads(fakeReads("technician", {}));
    await listJobWorkTimeEntries("job-1", null);
    expect(mockCalls.map((c) => c.table)).toEqual(["time_entries"]);
  });

  it("a job absent from the mirror answers from Supabase", async () => {
    setLocalReads(fakeReads("technician", {}, false));
    await listJobWorkTimeEntries("job-1", "tech-7");
    expect(mockCalls.map((c) => c.table)).toEqual(["time_entries"]);
  });

  it("only counts WORK entries, on both paths", async () => {
    expect(SQL_JOB_WORK_ENTRIES_ALL).toMatch(/entry_type = 'work'/);
    expect(SQL_JOB_WORK_ENTRIES_OWN).toMatch(/entry_type = 'work'/);
    resetSourceForTests();
    await listJobWorkTimeEntries("job-1", "u1");
    expect(mockCalls[0].chain).toContainEqual(["eq", ["entry_type", "work"]]);
  });

  it("names no money column on either path", async () => {
    expect(SQL_JOB_WORK_ENTRIES_ALL).not.toMatch(MONEY);
    expect(SQL_JOB_WORK_ENTRIES_OWN).not.toMatch(MONEY);
    await listJobWorkTimeEntries("job-1", "u1");
    const select = mockCalls[0].chain.find(([m]) => m === "select")![1][0] as string;
    expect(select).not.toMatch(MONEY);
  });
});

describe("getJobAllocatedHours", () => {
  it("office: local SUM equals the remote purchase_orders_public SUM", async () => {
    setLocalReads(fakeReads("office", { [SQL_JOB_PO_HOURS]: [{ total_hours: 10 }, { total_hours: "2.5" }, { total_hours: null }] }));
    const local = await getJobAllocatedHours("job-1");
    expect(mockCalls).toHaveLength(0);

    resetSourceForTests();
    mockResponses.purchase_orders_public = { data: [{ total_hours: 10 }, { total_hours: 2.5 }, { total_hours: null }], error: null };
    const remote = await getJobAllocatedHours("job-1");
    expect(local).toBe(12.5);
    expect(remote).toBe(12.5);
  });

  it("technician: never local (purchase_orders is not in their stream) — reads the money-free view", async () => {
    const db = fakeReads("technician", {});
    setLocalReads(db);
    await getJobAllocatedHours("job-1");
    expect(db.getAll).not.toHaveBeenCalled();
    expect(mockCalls.map((c) => c.table)).toEqual(["purchase_orders_public"]);
    const select = mockCalls[0].chain.find(([m]) => m === "select")![1][0];
    expect(select).toBe("total_hours");
  });

  it("throws on a failed remote read instead of reporting zero hours", async () => {
    mockResponses.purchase_orders_public = { data: null, error: { message: "boom" } };
    await expect(getJobAllocatedHours("job-1")).rejects.toThrow(/getJobAllocatedHours: boom/);
  });
});
