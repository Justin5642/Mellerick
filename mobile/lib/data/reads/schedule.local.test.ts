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
import {
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
    const getOptional = jest.fn().mockResolvedValue({ n: 2 });
    setLocalReads(fakeReads({ getOptional }));

    await expect(countOtherScheduledJobs("tech-2", "2026-10-09", "this-job")).resolves.toBe(2);

    const [sql, params] = getOptional.mock.calls[0];
    expect(sql).toBe(SQL_COUNT_OTHER_SCHEDULED_JOBS);
    expect(norm(sql)).toContain(
      "WHERE (j.assigned_to = ?1 OR j.id IN (SELECT ja.job_id FROM job_assignments ja WHERE ja.staff_id = ?1))"
    );
    expect(norm(sql)).toContain("AND j.id != ?2 AND j.scheduled_start >= ?3 AND j.scheduled_start < ?4");
    expect(params[0]).toBe("tech-2");
    expect(params[1]).toBe("this-job");
    expect(params).toHaveLength(4);
    expect(supabase.from as jest.Mock).not.toHaveBeenCalled();
  });
});
