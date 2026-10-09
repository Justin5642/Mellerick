// Office dashboard: office/admin only, and local == remote shape.
const mockCalls: { table: string; chain: [string, unknown[]][] }[] = [];
const mockQueue: Record<string, unknown[]> = {};
jest.mock("../../supabase", () => ({
  supabase: {
    from: (table: string) => {
      const entry = { table, chain: [] as [string, unknown[]][] };
      mockCalls.push(entry);
      const response = (mockQueue[table] ?? []).shift() ?? { data: [], error: null, count: 0 };
      const builder: Record<string, unknown> = {};
      for (const m of ["select", "eq", "in", "not", "order", "limit"]) {
        builder[m] = (...args: unknown[]) => {
          entry.chain.push([m, args]);
          return builder;
        };
      }
      builder.then = (resolve: (v: unknown) => unknown) => resolve(response);
      return builder;
    },
  },
}));

import { resetSourceForTests, setLocalReads, type LocalReads, type LocalRole } from "./source";
import {
  getOfficeDashboard,
  SQL_DASHBOARD_COUNTS,
  SQL_DASHBOARD_RECENT_JOBS,
  SQL_DASHBOARD_SCHEDULED_JOBS,
  type OfficeDashboard,
} from "./dashboard";

const SQLITE_JOB = {
  id: "j1", job_number: 833, title: "Leak", status: "scheduled", priority: "high",
  scheduled_start: "2026-10-09T23:00:00Z", scheduled_end: null, customer_name: "Acme", assigned_full_name: "Jake H",
};
const SQLITE_UNASSIGNED = { ...SQLITE_JOB, id: "j2", job_number: "834", customer_name: null, assigned_full_name: null };

const remoteJob = ({ customer_name, assigned_full_name, ...j }: typeof SQLITE_JOB) => ({
  ...j,
  job_number: Number(j.job_number),
  customers: customer_name ? { name: customer_name } : null,
  assigned_profile: assigned_full_name ? { full_name: assigned_full_name } : null,
});

const EXPECTED_JOBS = [
  { ...remoteJob(SQLITE_JOB) },
  { ...remoteJob(SQLITE_UNASSIGNED as unknown as typeof SQLITE_JOB) },
];
const EXPECTED: OfficeDashboard = {
  counts: { total: 825, active: 40, customers: 300, overdue: 4 },
  recent: EXPECTED_JOBS,
  scheduled: EXPECTED_JOBS,
};

function fakeReads(role: LocalRole): LocalReads & { getAll: jest.Mock; getOptional: jest.Mock } {
  return {
    hasSynced: () => true,
    role: () => role,
    getAll: jest.fn(async (sql: string) =>
      sql === SQL_DASHBOARD_RECENT_JOBS || sql === SQL_DASHBOARD_SCHEDULED_JOBS ? [SQLITE_JOB, SQLITE_UNASSIGNED] : []
    ),
    getOptional: jest.fn(async (sql: string) =>
      sql === SQL_DASHBOARD_COUNTS ? { total: 825, active: "40", customers: 300, overdue: 4 } : null
    ),
  } as LocalReads & { getAll: jest.Mock; getOptional: jest.Mock };
}

afterEach(() => {
  resetSourceForTests();
  mockCalls.length = 0;
  for (const k of Object.keys(mockQueue)) delete mockQueue[k];
});

describe("getOfficeDashboard", () => {
  it("office: local and remote return identical shapes", async () => {
    setLocalReads(fakeReads("office"));
    const local = await getOfficeDashboard();
    expect(mockCalls).toHaveLength(0); // zero network round-trips

    resetSourceForTests();
    mockQueue.jobs = [
      { data: null, error: null, count: 825 },
      { data: null, error: null, count: 40 },
      { data: EXPECTED_JOBS.map((j) => ({ ...j })), error: null },
      { data: EXPECTED_JOBS.map((j) => ({ ...j })), error: null },
    ];
    mockQueue.customers = [{ data: null, error: null, count: 300 }];
    mockQueue.invoices = [{ data: null, error: null, count: 4 }];
    const remote = await getOfficeDashboard();

    expect(local).toEqual(EXPECTED);
    expect(remote).toEqual(EXPECTED);
  });

  it("admin is served locally too", async () => {
    const db = fakeReads("admin");
    setLocalReads(db);
    await getOfficeDashboard();
    expect(mockCalls).toHaveLength(0);
  });

  it("a technician's mirror is NEVER used — it holds only their jobs and no invoices", async () => {
    const db = fakeReads("technician");
    setLocalReads(db);
    await getOfficeDashboard();
    expect(db.getAll).not.toHaveBeenCalled();
    expect(db.getOptional).not.toHaveBeenCalled();
    expect(mockCalls.length).toBeGreaterThan(0);
  });

  it("a failed remote count throws rather than rendering a believable zero", async () => {
    mockQueue.invoices = [{ data: null, error: { message: "boom" }, count: null }];
    await expect(getOfficeDashboard()).rejects.toThrow(/overdueInvoices: boom/);
  });

  it("local counts use the same filters as the remote ones", () => {
    expect(SQL_DASHBOARD_COUNTS).toMatch(/j\.status IN \('pending', 'scheduled', 'in_progress'\)/);
    expect(SQL_DASHBOARD_COUNTS).toMatch(/customers c WHERE c\.is_active = 1/);
    expect(SQL_DASHBOARD_COUNTS).toMatch(/invoices i WHERE i\.status = 'overdue'/);
    expect(SQL_DASHBOARD_SCHEDULED_JOBS).toMatch(/scheduled_start IS NOT NULL/);
    expect(SQL_DASHBOARD_SCHEDULED_JOBS).toMatch(/NOT IN \('completed', 'cancelled'\)/);
    expect(SQL_DASHBOARD_RECENT_JOBS).toMatch(/ORDER BY j\.created_at DESC\s+LIMIT 8/);
  });
});
