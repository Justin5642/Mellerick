// listAssignableStaff through the LocalReads seam: a fake device DB is
// injected via setLocalReads and fed SQLite-shaped rows (full_name-ordered,
// as the SQL returns them); we assert the JS role re-sort produced the
// PostgREST-path ordering, plus the exact SQL/params the fake received. The
// supabase client is mocked per backflow.test.ts so the native AsyncStorage
// chain never loads — and so the role-gate test can prove the remote path
// was taken.
jest.mock("../../supabase", () => {
  const builder: any = {};
  Object.assign(builder, {
    select: jest.fn(() => builder),
    eq: jest.fn(() => builder),
    order: jest.fn(() => builder),
    then: (resolve: (v: unknown) => void) => resolve({ data: [] }),
  });
  return { supabase: { from: jest.fn(() => builder) } };
});

import { supabase } from "../../supabase";
import {
  resetSourceForTests,
  setLocalReads,
  type LocalReads,
  type LocalRole,
} from "./source";
import { buildScheduleColumns } from "../../scheduling";
import { fromBusinessInputValue } from "../../date";
import {
  countOccupying,
  countOtherScheduledJobs,
  listAssignableStaff,
  SQL_COUNT_OTHER_SCHEDULED_JOBS,
  SQL_LIST_ASSIGNABLE_STAFF,
  type AssignableStaff,
} from "./schedule";

const norm = (s: string) => s.replace(/\s+/g, " ").trim();

const EXPECTED_SQL = norm(`
  SELECT id, full_name, role FROM profiles WHERE is_active = 1
  ORDER BY full_name COLLATE NOCASE`);

function fakeReads(over: Partial<LocalReads> = {}): LocalReads {
  return {
    hasSynced: () => true,
    role: () => "office" as LocalRole,
    getAll: jest.fn().mockResolvedValue([]),
    getOptional: jest.fn().mockResolvedValue(null),
    ...over,
  };
}

describe("listAssignableStaff (local path)", () => {
  afterEach(() => {
    resetSourceForTests();
    jest.clearAllMocks();
  });

  it("re-sorts SQL name-ordered rows to technician < office < admin, alphabetical within role", async () => {
    // Rows arrive from SQLite in ORDER BY full_name COLLATE NOCASE order —
    // the JS re-sort must put technicians first, then office, then admin,
    // keeping the alphabetical order as the tiebreak.
    const sqliteRows: AssignableStaff[] = [
      { id: "p4", full_name: "Adam Tech", role: "technician" },
      { id: "p1", full_name: "Alice Admin", role: "admin" },
      { id: "p2", full_name: "Bob Tech", role: "technician" },
      { id: "p3", full_name: "Carol Office", role: "office" },
    ];
    const getAll = jest.fn().mockResolvedValue(sqliteRows);
    setLocalReads(fakeReads({ getAll }));

    const result = await listAssignableStaff();

    const expected: AssignableStaff[] = [
      { id: "p4", full_name: "Adam Tech", role: "technician" },
      { id: "p2", full_name: "Bob Tech", role: "technician" },
      { id: "p3", full_name: "Carol Office", role: "office" },
      { id: "p1", full_name: "Alice Admin", role: "admin" },
    ];
    expect(result).toEqual(expected);

    expect(getAll).toHaveBeenCalledTimes(1);
    const [sql, params] = getAll.mock.calls[0];
    expect(norm(sql)).toBe(EXPECTED_SQL);
    expect(norm(SQL_LIST_ASSIGNABLE_STAFF)).toBe(EXPECTED_SQL);
    expect(params).toEqual([]); // no bound parameters
    expect(supabase.from as jest.Mock).not.toHaveBeenCalled();
  });

  it("returns [] from an empty local table without touching supabase", async () => {
    const getAll = jest.fn().mockResolvedValue([]);
    setLocalReads(fakeReads({ getAll }));

    const result = await listAssignableStaff();

    expect(result).toEqual([]);
    expect(getAll).toHaveBeenCalledTimes(1);
    expect(supabase.from as jest.Mock).not.toHaveBeenCalled();
  });

  it("never touches the local DB for a role outside the allow-list", async () => {
    const getAll = jest.fn().mockResolvedValue([]);
    setLocalReads(fakeReads({ getAll, role: () => "technician" as LocalRole }));

    const result = await listAssignableStaff();

    expect(getAll).not.toHaveBeenCalled(); // local rows would be silently scoped/empty
    expect(supabase.from as jest.Mock).toHaveBeenCalledWith("profiles"); // RLS stays the loud gate
    expect(result).toEqual([]);
  });
});

describe("countOtherScheduledJobs (local path)", () => {
  afterEach(() => {
    resetSourceForTests();
    jest.clearAllMocks();
  });

  it("counts crew jobs (job_assignments) as well as jobs.assigned_to, binding the id once", async () => {
    const at = (key: string, time: string) => fromBusinessInputValue(`${key}T${time}`);
    const getAll = jest.fn().mockResolvedValue([
      { id: "a", scheduled_start: at("2026-10-09", "07:00"), scheduled_end: at("2026-10-09", "10:00"), schedule_daily: 0 },
      { id: "b", scheduled_start: at("2026-10-09", "13:00"), scheduled_end: null, schedule_daily: 0 },
    ]);
    setLocalReads(fakeReads({ getAll }));

    await expect(countOtherScheduledJobs("tech-2", "2026-10-09", "this-job")).resolves.toBe(2);

    const [sql, params] = getAll.mock.calls[0];
    expect(sql).toBe(SQL_COUNT_OTHER_SCHEDULED_JOBS);
    expect(norm(sql)).toContain(
      "WHERE (j.assigned_to = ?1 OR j.id IN (SELECT ja.job_id FROM job_assignments ja WHERE ja.staff_id = ?1))"
    );
    expect(norm(sql)).toContain(
      "AND j.id != ?2 AND j.scheduled_start < ?4 AND (j.scheduled_end >= ?3 OR (j.scheduled_end IS NULL AND j.scheduled_start >= ?3))"
    );
    expect(params[0]).toBe("tech-2");
    expect(params[1]).toBe("this-job");
    expect(params).toHaveLength(4);
    expect(supabase.from as jest.Mock).not.toHaveBeenCalled();
  });

  it("counts a daily job on every booked day of its range, but not on a weekend it skips (0071)", async () => {
    // Thu 22 – Mon 26 Oct 2026, all day: books Thu, Fri, Mon — not Sat 24.
    const daily = { id: "d", ...buildScheduleColumns({ startDateKey: "2026-10-22", endDateKey: "2026-10-26", startTime: "", endTime: "", allDay: true }) };
    const row = { id: daily.id, scheduled_start: daily.scheduled_start, scheduled_end: daily.scheduled_end, schedule_daily: 1 };
    const getAll = jest.fn().mockResolvedValue([row]);
    setLocalReads(fakeReads({ getAll }));

    await expect(countOtherScheduledJobs("tech-2", "2026-10-23", "this-job")).resolves.toBe(1); // a middle day
    await expect(countOtherScheduledJobs("tech-2", "2026-10-24", "this-job")).resolves.toBe(0); // skipped Saturday
    // Without the flag the same window is one long block, booked on its start day only.
    getAll.mockResolvedValue([{ ...row, schedule_daily: 0 }]);
    await expect(countOtherScheduledJobs("tech-2", "2026-10-23", "this-job")).resolves.toBe(0);
  });

  it("countOccupying treats SQLite 1/0 and PostgREST true/false alike", () => {
    const cols = buildScheduleColumns({ startDateKey: "2026-10-19", endDateKey: "2026-10-21", startTime: "", endTime: "", allDay: true });
    const base = { id: "x", scheduled_start: cols.scheduled_start, scheduled_end: cols.scheduled_end };
    expect(countOccupying([{ ...base, schedule_daily: 1 }], "2026-10-20")).toBe(1);
    expect(countOccupying([{ ...base, schedule_daily: true }], "2026-10-20")).toBe(1);
    expect(countOccupying([{ ...base, schedule_daily: null }], "2026-10-20")).toBe(0);
  });
});
