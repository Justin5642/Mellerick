// London-school tests for the reports read module's local (PowerSync) paths.
// A fake LocalReads is injected through the seam; rows are SQLite-shaped
// (numbers for numerics — the client schema declares column.real — integers
// for booleans, flat JOIN aliases). Assertions cover BOTH the mapped output
// (must equal the PostgREST-shaped interfaces) and the exact SQL + params the
// fake received (normalized whitespace).
//
// getStaffEfficiency (Supabase-only) and the role-gate fallbacks execute the
// real remote bodies, so the supabase mock must be chainable AND awaitable.
const mockFrom = jest.fn();
jest.mock("../../supabase", () => ({
  supabase: { from: (...args: unknown[]) => mockFrom(...args) },
}));

import {
  getReportSummary,
  getEquipmentUtilization,
  getReportAnalytics,
  getStaffEfficiency,
  SQL_REPORT_PAID_INVOICES,
  SQL_REPORT_OUTSTANDING_INVOICES,
  SQL_REPORT_QUOTES,
  SQL_REPORT_JOB_COUNTS,
  SQL_EQUIPMENT_UTILIZATION_EQUIPMENT,
  SQL_EQUIPMENT_UTILIZATION_USAGE,
  SQL_ANALYTICS_INVOICES,
  SQL_ANALYTICS_JOBS,
} from "./reports";
import { setLocalReads, resetSourceForTests, type LocalReads, type LocalRole } from "./source";

const norm = (s: string) => s.replace(/\s+/g, " ").trim();

/** Chainable + thenable stand-in for a PostgREST builder. */
function chainResolving(data: unknown[] | null = null, count = 0) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const chain: any = {};
  for (const m of ["select", "eq", "in", "gte", "lte", "not", "or", "order", "is", "limit", "range"]) {
    chain[m] = jest.fn(() => chain);
  }
  chain.then = (onFulfilled?: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) =>
    Promise.resolve({ data, count, error: null }).then(onFulfilled, onRejected);
  return chain;
}

/** Fake LocalReads routing getAll by normalized SQL. */
function fakeReads(bySql: Record<string, Record<string, unknown>[]>, role: Exclude<LocalRole, null> = "office") {
  const getAll = jest.fn(async (sql: string, _params?: unknown[]) => {
    const key = Object.keys(bySql).find((k) => norm(k) === norm(sql));
    if (!key) throw new Error(`fake LocalReads got unexpected SQL: ${norm(sql)}`);
    return bySql[key];
  });
  const fake = {
    hasSynced: () => true,
    role: () => role,
    getAll,
    getOptional: jest.fn(async () => null),
  };
  return { fake: fake as unknown as LocalReads, getAll };
}

function receivedCalls(getAll: jest.Mock): [string, unknown[] | undefined][] {
  return getAll.mock.calls.map(([sql, params]) => [norm(sql as string), params as unknown[] | undefined]);
}

beforeEach(() => {
  mockFrom.mockImplementation(() => chainResolving());
});

afterEach(() => {
  resetSourceForTests();
  jest.clearAllMocks();
  jest.useRealTimers();
});

describe("getReportSummary (local)", () => {
  const rows = {
    [SQL_REPORT_PAID_INVOICES]: [{ total: 100 }, { total: 50.5 }, { total: null }],
    [SQL_REPORT_OUTSTANDING_INVOICES]: [
      { total: 200, status: "sent" },
      { total: 80, status: "overdue" },
    ],
    [SQL_REPORT_QUOTES]: [
      { status: "accepted", total: 300 },
      { status: "declined", total: 40 },
      { status: "draft", total: 10 },
    ],
    // Deliberately only 2 of the 6 job statuses — GROUP BY omits empty buckets.
    [SQL_REPORT_JOB_COUNTS]: [
      { status: "in_progress", c: 3 },
      { status: "completed", c: 7 },
    ],
  };

  it("maps SQLite rows to the PostgREST-shaped summary and sends the expected SQL", async () => {
    const { fake, getAll } = fakeReads(rows);
    setLocalReads(fake);

    await expect(getReportSummary()).resolves.toEqual({
      revenuePaid: 150.5,
      outstanding: 280,
      totalOverdue: 80,
      quotesAccepted: 1,
      quotesDeclined: 1,
      quotesTotal: 3,
      acceptedValue: 300,
      quotesByStatus: [
        { status: "draft", count: 1 },
        { status: "sent", count: 0 },
        { status: "accepted", count: 1 },
        { status: "declined", count: 1 },
        { status: "expired", count: 0 },
      ],
      jobsByStatus: [
        { status: "pending", count: 0 },
        { status: "scheduled", count: 0 },
        { status: "in_progress", count: 3 },
        { status: "on_hold", count: 0 },
        { status: "completed", count: 7 },
        { status: "cancelled", count: 0 },
      ],
      activeJobs: 3,
    });

    expect(receivedCalls(getAll)).toEqual([
      [norm(SQL_REPORT_PAID_INVOICES), undefined],
      [norm(SQL_REPORT_OUTSTANDING_INVOICES), undefined],
      [norm(SQL_REPORT_QUOTES), undefined],
      [norm(SQL_REPORT_JOB_COUNTS), undefined],
    ]);
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it("re-expands GROUP BY buckets to all six job statuses, declared order, zero-filled", async () => {
    const { fake } = fakeReads({
      ...rows,
      [SQL_REPORT_JOB_COUNTS]: [
        // Returned out of declared order on purpose — output order must come
        // from JOB_STATUSES, not from the result set.
        { status: "cancelled", c: 2 },
        { status: "pending", c: 5 },
      ],
    });
    setLocalReads(fake);

    const summary = await getReportSummary();
    expect(summary.jobsByStatus).toEqual([
      { status: "pending", count: 5 },
      { status: "scheduled", count: 0 },
      { status: "in_progress", count: 0 },
      { status: "on_hold", count: 0 },
      { status: "completed", count: 0 },
      { status: "cancelled", count: 0 },
    ].map((b) => (b.status === "cancelled" ? { ...b, count: 2 } : b)));
    expect(summary.activeJobs).toBe(5); // pending only — cancelled is not active
  });
});

describe("getEquipmentUtilization (local)", () => {
  it("maps rows, passes the 12-month cutoff param, and computes utilisation", async () => {
    jest.useFakeTimers({ now: new Date("2026-07-15T12:00:00Z") });
    const { fake, getAll } = fakeReads({
      [SQL_EQUIPMENT_UTILIZATION_EQUIPMENT]: [
        {
          id: "e1",
          name: "Excavator",
          purchase_cost: 100000,
          estimated_life_years: 10,
          insurance_annual: 1000,
          maintenance_annual: 2000,
          registration_annual: 500,
          other_annual_costs: 500,
          fuel_cost_per_hour: 10,
          target_hours_per_year: 1000,
        },
        {
          id: "e2",
          name: "Trailer",
          purchase_cost: 5000,
          estimated_life_years: 5,
          insurance_annual: 100,
          maintenance_annual: 0,
          registration_annual: 0,
          // Nullable cost columns arrive NULL from SQLite — must coerce to 0.
          other_annual_costs: null,
          fuel_cost_per_hour: null,
          target_hours_per_year: null,
        },
      ],
      [SQL_EQUIPMENT_UTILIZATION_USAGE]: [
        { equipment_id: "e1", hours: 100, usage_date: "2026-01-05" },
        { equipment_id: "e1", hours: 50, usage_date: "2026-02-01" },
      ],
    });
    setLocalReads(fake);

    await expect(getEquipmentUtilization()).resolves.toEqual([
      {
        name: "Excavator",
        hoursUsed: 150,
        // fixed = 100000/10 + 1000 + 2000 + 500 + 500 = 14000; fuel = 10*1000
        budgetedCostPerHour: 24,
        annualTotalCost: 24000,
        utilizationPct: 15,
        trueCostPerHourUsed: 14000 / 150 + 10,
      },
      {
        name: "Trailer",
        hoursUsed: 0,
        budgetedCostPerHour: 0, // no target hours
        annualTotalCost: 1100, // 5000/5 + 100
        utilizationPct: null,
        trueCostPerHourUsed: null,
      },
    ]);

    expect(receivedCalls(getAll)).toEqual([
      [norm(SQL_EQUIPMENT_UTILIZATION_EQUIPMENT), undefined],
      [norm(SQL_EQUIPMENT_UTILIZATION_USAGE), ["2025-07-15"]], // 12 months before the fake now
    ]);
    expect(mockFrom).not.toHaveBeenCalled();
  });
});

describe("getReportAnalytics (local)", () => {
  it("rebuilds the embed shapes from JOIN aliases and feeds the pure helpers", async () => {
    jest.useFakeTimers({ now: new Date("2026-07-15T12:00:00Z") }); // Melbourne: 2026-07-15 evening
    const { fake, getAll } = fakeReads({
      [SQL_ANALYTICS_INVOICES]: [
        { customer_id: "c1", total: 100, status: "paid", created_at: "2026-07-01T00:00:00Z", customer_name: "Acme" },
        { customer_id: "c1", total: 50, status: "sent", created_at: "2026-06-10T00:00:00Z", customer_name: "Acme" },
        // Cancelled + a NULL to-one join (deleted customer) — excluded from spend.
        { customer_id: "c2", total: 500, status: "cancelled", created_at: "2026-05-01T00:00:00Z", customer_name: null },
      ],
      [SQL_ANALYTICS_JOBS]: [
        { status: "completed", assignee_name: "Alice" },
        { status: "pending", assignee_name: "Alice" },
        { status: "completed", assignee_name: null }, // unassigned — excluded (web parity)
      ],
    });
    setLocalReads(fake);

    await expect(getReportAnalytics()).resolves.toEqual({
      topCustomers: [{ customerId: "c1", name: "Acme", total: 150 }],
      revenueByMonth: [
        { monthKey: "2026-02", paid: 0, outstanding: 0 },
        { monthKey: "2026-03", paid: 0, outstanding: 0 },
        { monthKey: "2026-04", paid: 0, outstanding: 0 },
        { monthKey: "2026-05", paid: 0, outstanding: 0 },
        { monthKey: "2026-06", paid: 0, outstanding: 50 },
        { monthKey: "2026-07", paid: 100, outstanding: 0 },
      ],
      jobsByStaff: [{ name: "Alice", completed: 1, total: 2, rate: 50 }],
    });

    expect(receivedCalls(getAll)).toEqual([
      [norm(SQL_ANALYTICS_INVOICES), undefined],
      [norm(SQL_ANALYTICS_JOBS), undefined],
    ]);
    expect(mockFrom).not.toHaveBeenCalled();
  });
});

describe("role gate and Supabase-only paths", () => {
  it("routes every gated read to Supabase for a technician — the ready fake is never touched", async () => {
    const { fake, getAll } = fakeReads({}, "technician");
    setLocalReads(fake);

    await getReportSummary();
    await getEquipmentUtilization();
    await getReportAnalytics();

    expect(getAll).not.toHaveBeenCalled();
    const tables = mockFrom.mock.calls.map((c) => c[0]);
    expect(tables).toContain("invoices");
    expect(tables).toContain("quotes");
    expect(tables).toContain("jobs");
    expect(tables).toContain("equipment");
    expect(tables).toContain("equipment_usage_log");
  });

  it("getStaffEfficiency never reads locally, even for an admin (tables unpublished)", async () => {
    const { fake, getAll } = fakeReads({}, "admin");
    setLocalReads(fake);

    await expect(getStaffEfficiency()).resolves.toEqual([]);

    expect(getAll).not.toHaveBeenCalled();
    const tables = mockFrom.mock.calls.map((c) => c[0]);
    expect(tables).toEqual(
      expect.arrayContaining(["staff_cost_profiles", "staff_leave", "time_entries", "equipment", "profiles"])
    );
  });
});
