// reads/bookings.ts: the three states (no table yet / table on the server but
// not on the device / everything deployed) and the shapes both paths return.
// The supabase client is a recording fake answering per table, as in
// assignedJobs.remote.test.ts.
const mockCalls: { table: string; method: string; args: unknown[] }[] = [];
let mockAnswers: Record<string, unknown> = {};

jest.mock("../../supabase", () => {
  function builder(table: string) {
    const b: Record<string, unknown> = {};
    for (const m of ["select", "eq", "in", "not", "order"]) {
      b[m] = (...args: unknown[]) => {
        mockCalls.push({ table, method: m, args });
        return b;
      };
    }
    b.then = (resolve: (v: unknown) => unknown) => resolve(mockAnswers[table] ?? { data: [], error: null });
    return b;
  }
  return { supabase: { from: (table: string) => builder(table) } };
});

import { resetSourceForTests, setLocalReads, type LocalReads, type LocalRole } from "./source";
import {
  isMissingTable,
  listJobBookings,
  listMyJobBookings,
  listOpenJobBookingsRemote,
  withMyBookings,
  SQL_JOB_BOOKINGS,
  SQL_JOB_SCHEDULE_ON_DEVICE,
  SQL_MY_OPEN_JOB_BOOKINGS,
} from "./bookings";

const MISSING = { data: null, error: { code: "PGRST205", message: "Could not find the table 'public.job_bookings' in the schema cache" } };

function fakeReads(getAll: jest.Mock, getOptional: jest.Mock = jest.fn().mockResolvedValue(null), role: LocalRole = "technician"): LocalReads {
  return { hasSynced: () => true, role: () => role, getAll, getOptional };
}

const localRow = {
  id: "b1",
  job_id: "j1",
  staff_id: "dave",
  cost_center_id: "cc1",
  starts_at: "2026-10-19 20:00:00Z",
  ends_at: "2026-10-20 04:30:00Z",
  daily: 1,
  all_day: 0,
};
const mapped = {
  id: "b1",
  job_id: "j1",
  staff_id: "dave",
  cost_center_id: "cc1",
  starts_at: "2026-10-19 20:00:00Z",
  ends_at: "2026-10-20 04:30:00Z",
  daily: true,
  all_day: false,
};

afterEach(() => {
  resetSourceForTests();
  mockCalls.length = 0;
  mockAnswers = {};
});

describe("isMissingTable", () => {
  it("recognises both codes for an absent table, and nothing else", () => {
    expect(isMissingTable({ code: "PGRST205" })).toBe(true);
    expect(isMissingTable({ code: "42P01" })).toBe(true);
    expect(isMissingTable({ code: "42501" })).toBe(false); // RLS: a real failure
    expect(isMissingTable(null)).toBe(false);
  });
});

describe("listJobBookings", () => {
  it("local: maps SQLite 1/0 to booleans and carries the name", async () => {
    const getAll = jest.fn().mockResolvedValue([{ ...localRow, staff_name: "Dave" }]);
    setLocalReads(fakeReads(getAll));
    expect(await listJobBookings("j1")).toEqual([{ ...mapped, staff_name: "Dave" }]);
    expect(getAll).toHaveBeenCalledWith(SQL_JOB_BOOKINGS, ["j1"]);
    expect(mockCalls).toEqual([]);
  });

  it("local: an unscheduled job on the device with no bookings is a real empty list", async () => {
    const getOptional = jest.fn().mockResolvedValue({ id: "j1", scheduled_start: null });
    setLocalReads(fakeReads(jest.fn().mockResolvedValue([]), getOptional));
    expect(await listJobBookings("j1")).toEqual([]);
    expect(getOptional).toHaveBeenCalledWith(SQL_JOB_SCHEDULE_ON_DEVICE, ["j1"]);
    expect(mockCalls).toEqual([]);
  });

  it("local: a SCHEDULED job with no bookings on the device asks the server (streams not redeployed yet)", async () => {
    const getOptional = jest.fn().mockResolvedValue({ id: "j1", scheduled_start: "2026-10-19 20:00:00Z" });
    setLocalReads(fakeReads(jest.fn().mockResolvedValue([]), getOptional));
    mockAnswers = { job_bookings: { data: [{ ...mapped, staff: { full_name: "Dave" } }], error: null } };
    expect(await listJobBookings("j1")).toEqual([{ ...mapped, staff_name: "Dave" }]);
    expect(mockCalls.some((c) => c.table === "job_bookings")).toBe(true);
  });

  it("local: a job not on the device asks the server", async () => {
    setLocalReads(fakeReads(jest.fn().mockResolvedValue([]), jest.fn().mockResolvedValue(null)));
    await listJobBookings("j1");
    expect(mockCalls.filter((c) => c.method === "eq")).toEqual([{ table: "job_bookings", method: "eq", args: ["job_id", "j1"] }]);
  });

  it("remote: null (not an error, not []) before 0079 is applied — draft, not applied yet", async () => {
    mockAnswers = { job_bookings: MISSING };
    expect(await listJobBookings("j1")).toBeNull();
  });

  it("remote: any other failure throws rather than reading as 'no bookings'", async () => {
    mockAnswers = { job_bookings: { data: null, error: { code: "42501", message: "permission denied" } } };
    await expect(listJobBookings("j1")).rejects.toThrow(/listJobBookings/);
  });

  it("remote: names the staff FK explicitly — job_bookings has two FKs to profiles", async () => {
    await listJobBookings("j1");
    const select = mockCalls.find((c) => c.method === "select")!;
    expect(select.args[0]).toContain("profiles!job_bookings_staff_id_fkey(full_name)");
  });
});

describe("listMyJobBookings", () => {
  const jobs = ["j1", "j2"];
  const j1Start = "2026-10-19 20:00:00Z";

  it("local: returns bookings on the given jobs only", async () => {
    const getAll = jest.fn().mockResolvedValue([
      { job_id_of_job: "j1", job_scheduled_start: j1Start, ...localRow },
      { job_id_of_job: "j2", job_scheduled_start: null, id: null, job_id: null, staff_id: null, cost_center_id: null, starts_at: null, ends_at: null, daily: null, all_day: null },
      { job_id_of_job: "j9", job_scheduled_start: "x", ...localRow, id: "b9", job_id: "j9" },
    ]);
    setLocalReads(fakeReads(getAll));
    expect(await listMyJobBookings("dave", jobs)).toEqual([mapped]);
    expect(getAll).toHaveBeenCalledWith(SQL_MY_OPEN_JOB_BOOKINGS, ["dave"]);
    expect(mockCalls).toEqual([]);
  });

  it("local: a scheduled job with no bookings on the device goes to the server", async () => {
    const getAll = jest.fn().mockResolvedValue([
      { job_id_of_job: "j1", job_scheduled_start: j1Start, id: null },
      { job_id_of_job: "j2", job_scheduled_start: null, id: null },
    ]);
    setLocalReads(fakeReads(getAll));
    mockAnswers = { job_bookings: { data: [mapped], error: null } };
    expect(await listMyJobBookings("dave", jobs)).toEqual([mapped]);
    expect(mockCalls.find((c) => c.method === "in")?.args).toEqual(["job_id", ["j1", "j2"]]);
  });

  it("local: a job the list has but the device lacks goes to the server", async () => {
    const getAll = jest.fn().mockResolvedValue([{ job_id_of_job: "j2", job_scheduled_start: null, id: null }]);
    setLocalReads(fakeReads(getAll));
    await listMyJobBookings("dave", jobs);
    expect(mockCalls.some((c) => c.table === "job_bookings")).toBe(true);
  });

  it("remote: null before 0079 is applied (a draft, not applied yet); no query at all for no jobs", async () => {
    mockAnswers = { job_bookings: MISSING };
    expect(await listMyJobBookings("dave", jobs)).toBeNull();
    mockCalls.length = 0;
    expect(await listMyJobBookings("dave", [])).toEqual([]);
    expect(mockCalls).toEqual([]);
  });
});

describe("listOpenJobBookingsRemote", () => {
  it("null when the table is missing; names otherwise", async () => {
    mockAnswers = { job_bookings: MISSING };
    expect(await listOpenJobBookingsRemote()).toBeNull();
    mockAnswers = { job_bookings: { data: [{ ...mapped, staff: null, jobs: { status: "scheduled" } }], error: null } };
    expect(await listOpenJobBookingsRemote()).toEqual([{ ...mapped, staff_name: null }]);
    expect(mockCalls.find((c) => c.method === "not")?.args).toEqual(["jobs.status", "in", '("completed","cancelled")']);
  });
});

describe("withMyBookings", () => {
  const sites = [
    { jobId: "j1", lat: 1, lng: 1, scheduledCostCenterId: "job-cc" },
    { jobId: "j2", lat: 2, lng: 2, scheduledCostCenterId: null },
  ];

  it("attaches each site's OWN bookings, as small windows", async () => {
    mockAnswers = {
      job_bookings: { data: [mapped, { ...mapped, id: "b2", staff_id: "sam" }], error: null },
    };
    const out = await withMyBookings("dave", sites);
    expect(out[0].bookings).toEqual([{ starts_at: mapped.starts_at, ends_at: mapped.ends_at, daily: true, cost_center_id: "cc1" }]);
    expect(out[1].bookings).toEqual([]);
  });

  it("returns the sites unchanged when bookings do not exist yet or cannot be read", async () => {
    mockAnswers = { job_bookings: MISSING };
    expect(await withMyBookings("dave", sites)).toEqual(sites);
    mockAnswers = { job_bookings: { data: null, error: { code: "08006", message: "offline" } } };
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    expect(await withMyBookings("dave", sites)).toEqual(sites);
    warn.mockRestore();
  });
});
