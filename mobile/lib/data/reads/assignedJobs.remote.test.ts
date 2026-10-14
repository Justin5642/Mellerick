// The REMOTE half of the "mine = any current assignee" rule (./assignedJobs):
// what listMyJobs, listMyJobSites and countOtherScheduledJobs ask Supabase when
// the mirror cannot answer. Each local SQL twin is pinned in its module's
// *.local.test.ts; this file pins that the network path applies the SAME rule,
// because a fallback that still filtered on jobs.assigned_to alone would hide
// crew jobs exactly when the technician is online and the mirror is not ready.
//
// The supabase client is a recording fake: every chained call is logged per
// `from(table)` and each table mockAnswers with its canned rows.
const mockCalls: { table: string; method: string; args: unknown[] }[] = [];
let mockAnswers: Record<string, unknown> = {};

jest.mock("../../supabase", () => {
  function builder(table: string) {
    const b: Record<string, unknown> = {};
    for (const m of ["select", "eq", "neq", "not", "or", "gte", "lt", "order", "limit"]) {
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

import { resetSourceForTests, setLocalReads, type LocalReads } from "./source";
import { listMyJobs, listMyJobSites } from "./jobs";
import { countOtherScheduledJobs } from "./schedule";
import { assignedOrCrewFilter, overlapFilter } from "./assignedJobs";
import { buildScheduleColumns, businessDayRange } from "../../scheduling";

const callsOn = (table: string, method: string) =>
  mockCalls.filter((c) => c.table === table && c.method === method).map((c) => c.args);

afterEach(() => {
  resetSourceForTests();
  mockCalls.length = 0;
  mockAnswers = {};
});

describe("assignedOrCrewFilter", () => {
  it("ORs the primary assignee with the crew's job ids", () => {
    expect(assignedOrCrewFilter("u1", ["a", "b"])).toBe("assigned_to.eq.u1,id.in.(a,b)");
  });

  it("degrades to assigned_to alone when the user is on no crew — never an empty in.()", () => {
    expect(assignedOrCrewFilter("u1", [])).toBe("assigned_to.eq.u1");
  });
});

describe("listMyJobs (remote)", () => {
  it("includes jobs the user is on through job_assignments, not just jobs.assigned_to", async () => {
    // No local reads registered → fromLocalOr goes straight to remote().
    mockAnswers = {
      job_assignments: { data: [{ job_id: "crew-job" }, { job_id: "crew-job" }], error: null },
      jobs: { data: [], error: null },
    };

    await listMyJobs("tech-2");

    expect(callsOn("job_assignments", "eq")).toEqual([["staff_id", "tech-2"]]);
    // Narrowed to open jobs so the id list stays URL-sized.
    expect(callsOn("job_assignments", "not")).toEqual([["jobs.status", "in", '("completed","cancelled")']]);
    // De-duplicated, then ORed with assigned_to.
    expect(callsOn("jobs", "or")).toEqual([["assigned_to.eq.tech-2,id.in.(crew-job)"]]);
    expect(callsOn("jobs", "eq")).toEqual([]);
  });

  it("fails loudly when the crew lookup fails, rather than rendering 'No jobs assigned'", async () => {
    mockAnswers = { job_assignments: { data: null, error: { message: "boom", code: "500" } } };
    await expect(listMyJobs("tech-2")).rejects.toThrow();
  });
});

describe("listMyJobSites (remote)", () => {
  it("applies the crew rule and returns the SAME shape as the local path", async () => {
    mockAnswers = {
      job_assignments: { data: [{ job_id: "j2" }], error: null },
      jobs: {
        data: [
          { id: "j1", scheduled_cost_center_id: "cc-1", sites: { site_lat: -37.82, site_lng: 144.99 } },
          { id: "j2", scheduled_cost_center_id: null, sites: { site_lat: -37.9, site_lng: 145.1 } },
          { id: "j3", scheduled_cost_center_id: null, sites: null },
        ],
        error: null,
      },
    };

    const remote = await listMyJobSites("tech-2");
    expect(callsOn("jobs", "or")).toEqual([["assigned_to.eq.tech-2,id.in.(j2)"]]);

    // Same rows through the local path must come out byte-identical.
    const local: LocalReads = {
      hasSynced: () => true,
      role: () => "technician",
      getAll: jest.fn().mockResolvedValue([
        { id: "j1", scheduled_cost_center_id: "cc-1", site_lat: -37.82, site_lng: 144.99 },
        { id: "j2", scheduled_cost_center_id: null, site_lat: -37.9, site_lng: 145.1 },
        { id: "j3", scheduled_cost_center_id: null, site_lat: null, site_lng: null },
      ]) as LocalReads["getAll"],
      getOptional: jest.fn() as LocalReads["getOptional"],
    };
    setLocalReads(local);
    const fromMirror = await listMyJobSites("tech-2");

    expect(remote).toEqual(fromMirror);
    expect(remote).toEqual([
      { jobId: "j1", lat: -37.82, lng: 144.99, scheduledCostCenterId: "cc-1" },
      { jobId: "j2", lat: -37.9, lng: 145.1, scheduledCostCenterId: null },
    ]);
  });
});

describe("countOtherScheduledJobs (remote)", () => {
  it("counts the technician's crew jobs OCCUPYING that day, narrowing the crew lookup to the same overlap", async () => {
    const { dayStartIso, dayEndIso } = businessDayRange("2026-10-21");
    // Mon 19 – Wed 21 Oct, daily: started two days ago, still books the 21st.
    const daily = buildScheduleColumns({ startDateKey: "2026-10-19", endDateKey: "2026-10-21", startTime: "", endTime: "", allDay: true });
    mockAnswers = {
      job_assignments: { data: [{ job_id: "crew-am" }], error: null },
      jobs: {
        data: [
          { id: "crew-am", scheduled_start: daily.scheduled_start, scheduled_end: daily.scheduled_end, schedule_daily: true },
          // Same window, NOT daily: one block, booked on the 19th only.
          { id: "legacy", scheduled_start: daily.scheduled_start, scheduled_end: daily.scheduled_end, schedule_daily: false },
        ],
        error: null,
      },
    };

    await expect(countOtherScheduledJobs("tech-2", "2026-10-21", "this-job")).resolves.toBe(1);

    const overlap = overlapFilter(dayStartIso);
    expect(callsOn("job_assignments", "lt")).toEqual([["jobs.scheduled_start", dayEndIso]]);
    expect(callsOn("job_assignments", "or")).toEqual([[overlap, { referencedTable: "jobs" }]]);
    // The jobs query uses the identical overlap.
    expect(callsOn("jobs", "lt")).toEqual([["scheduled_start", dayEndIso]]);
    expect(callsOn("jobs", "or")).toEqual([["assigned_to.eq.tech-2,id.in.(crew-am)"], [overlap]]);
    expect(callsOn("jobs", "neq")).toEqual([["id", "this-job"]]);
    expect(callsOn("jobs", "select")).toEqual([["id, scheduled_start, scheduled_end, schedule_daily"]]);
  });

  it("returns the same count as the local path for the same rows", async () => {
    const daily = buildScheduleColumns({ startDateKey: "2026-10-19", endDateKey: "2026-10-21", startTime: "", endTime: "", allDay: true });
    const base = { id: "d", scheduled_start: daily.scheduled_start, scheduled_end: daily.scheduled_end };
    mockAnswers = { job_assignments: { data: [], error: null }, jobs: { data: [{ ...base, schedule_daily: true }], error: null } };
    const remote = await countOtherScheduledJobs("tech-2", "2026-10-20", "this-job");

    setLocalReads({
      hasSynced: () => true,
      role: () => "office",
      getAll: jest.fn().mockResolvedValue([{ ...base, schedule_daily: 1 }]) as LocalReads["getAll"],
      getOptional: jest.fn().mockResolvedValue(null) as LocalReads["getOptional"],
    });
    const local = await countOtherScheduledJobs("tech-2", "2026-10-20", "this-job");
    expect(remote).toBe(1);
    expect(local).toBe(remote);
  });
});
