// London-school tests for the local (PowerSync) path of reads/customers:
// a fake LocalReads is injected through the seam, fed SQLite-shaped rows
// (1/0 booleans, plain numbers for numerics, nulls), and the output must
// equal the PostgREST-shaped interfaces the screens consume. The SQL text
// and bind params the fake receives are asserted on normalized whitespace.
//
// The supabase client is mocked with a self-returning, thenable builder so
// the remote path (taken for the role-gate test) resolves to empty data
// without touching the network — same isolation pattern as backflow.test.ts.
jest.mock("../../supabase", () => {
  const builder: Record<string, unknown> = {};
  for (const m of ["select", "eq", "order", "or", "range", "single"]) {
    builder[m] = jest.fn(() => builder);
  }
  // Awaiting the builder (or any chained call) yields "no rows".
  (builder as { then?: unknown }).then = (resolve: (v: unknown) => unknown) => resolve({ data: null });
  return { supabase: { from: jest.fn(() => builder) } };
});

import { supabase } from "../../supabase";
import { resetSourceForTests, setLocalReads, type LocalReads, type LocalRole } from "./source";
import { getCustomer, getCustomerOverview, listCustomers } from "./customers";

/** Whitespace-normalize SQL for comparison. */
function norm(sql: string): string {
  return sql.replace(/\s+/g, " ").trim();
}

function fakeReads(over: Partial<LocalReads> = {}): LocalReads {
  return {
    hasSynced: () => true,
    role: () => "office" as LocalRole,
    getAll: jest.fn().mockResolvedValue([]),
    getOptional: jest.fn().mockResolvedValue(null),
    ...over,
  };
}

afterEach(() => {
  resetSourceForTests();
  jest.clearAllMocks();
});

describe("listCustomers (local)", () => {
  const sqliteRows = [
    { id: "c1", name: "Acme Plumbing", company: "Acme Pty Ltd", phone: "0400 000 000", email: "acme@example.com", is_active: 1, is_favorite: 1 },
    { id: "c2", name: "Beta Water", company: null, phone: null, email: null, is_active: 1, is_favorite: 0 },
  ];

  it("maps SQLite rows to the PostgREST shape (1/0 → booleans)", async () => {
    const getAll = jest.fn().mockResolvedValue(sqliteRows);
    setLocalReads(fakeReads({ getAll }));

    const rows = await listCustomers(0, 25);

    expect(rows).toEqual([
      { id: "c1", name: "Acme Plumbing", company: "Acme Pty Ltd", phone: "0400 000 000", email: "acme@example.com", is_active: true, is_favorite: true },
      { id: "c2", name: "Beta Water", company: null, phone: null, email: null, is_active: true, is_favorite: false },
    ]);
    expect(getAll).toHaveBeenCalledTimes(1);
    const [sql, params] = getAll.mock.calls[0];
    expect(norm(sql)).toBe(norm(`
      SELECT id, name, company, phone, email, is_active, is_favorite
      FROM customers
      WHERE is_active = 1
        AND (?1 IS NULL OR name LIKE '%'||?1||'%' OR company LIKE '%'||?1||'%')
      ORDER BY is_favorite DESC, name COLLATE NOCASE, id
      LIMIT ? OFFSET ?`));
    // No search: ?1 must be NULL so the LIKE branch collapses; then LIMIT, OFFSET.
    expect(params).toEqual([null, 25, 0]);
  });

  it("strips LIKE-hostile characters from the query and binds it as ?1", async () => {
    const getAll = jest.fn().mockResolvedValue([]);
    setLocalReads(fakeReads({ getAll }));

    await listCustomers(50, 25, "Acme%");

    const [, params] = getAll.mock.calls[0];
    // Same [,()%]-strip as the Supabase path, then bound (not interpolated).
    expect(params).toEqual(["Acme", 25, 50]);
  });
});

describe("getCustomer (local)", () => {
  it("assembles the detail + sites embed from two statements", async () => {
    const getOptional = jest.fn().mockResolvedValue({
      id: "c1", name: "Acme Plumbing", company: "Acme Pty Ltd", email: "acme@example.com",
      phone: "0400 000 000", mobile: null, abn: "12 345 678 901", notes: "Gate code 4321",
      is_active: 1, is_favorite: 0,
    });
    const siteRows = [
      { id: "s1", name: "Head office", address_line1: "1 Main St", address_line2: null, suburb: "Richmond", state: "VIC", postcode: "3121", notes: "Dog on site" },
      { id: "s2", name: "Warehouse", address_line1: "9 Dock Rd", address_line2: "Unit 2", suburb: "Port Melbourne", state: "VIC", postcode: "3207", notes: null },
    ];
    const getAll = jest.fn().mockResolvedValue(siteRows);
    setLocalReads(fakeReads({ getOptional, getAll }));

    const detail = await getCustomer("c1");

    expect(detail).toEqual({
      id: "c1", name: "Acme Plumbing", company: "Acme Pty Ltd", email: "acme@example.com",
      phone: "0400 000 000", mobile: null, abn: "12 345 678 901", notes: "Gate code 4321",
      is_active: true, is_favorite: false,
      sites: siteRows,
    });
    const [custSql, custParams] = getOptional.mock.calls[0];
    expect(norm(custSql)).toBe(norm(`
      SELECT id, name, company, email, phone, mobile, abn, notes, is_active, is_favorite
      FROM customers WHERE id = ?`));
    expect(custParams).toEqual(["c1"]);
    const [sitesSql, sitesParams] = getAll.mock.calls[0];
    expect(norm(sitesSql)).toBe(norm(`
      SELECT id, name, address_line1, address_line2, suburb, state, postcode, notes
      FROM sites WHERE customer_id = ?`));
    expect(sitesParams).toEqual(["c1"]);
  });

  it("returns null for an unknown id without querying sites", async () => {
    const getOptional = jest.fn().mockResolvedValue(null);
    const getAll = jest.fn();
    setLocalReads(fakeReads({ getOptional, getAll }));

    await expect(getCustomer("nope")).resolves.toBeNull();
    expect(getAll).not.toHaveBeenCalled();
  });
});

describe("getCustomerOverview (local)", () => {
  it("maps the three lists and computes the rollup via summarizeCustomerInvoices", async () => {
    const getAll = jest.fn().mockImplementation(async (sql: string) => {
      const s = norm(sql);
      if (s.includes("FROM jobs")) {
        return [
          { id: "j1", job_number: 101, title: "Backflow test", status: "completed" },
          { id: "j2", job_number: 102, title: "Reticulation", status: "in_progress" },
        ];
      }
      if (s.includes("FROM quotes")) {
        return [{ id: "q1", title: "Pump replacement", status: "sent", total: 990.5 }];
      }
      if (s.includes("FROM invoices")) {
        return [
          { id: "i1", title: "March works", status: "paid", total: 1100 },
          { id: "i2", title: "April works", status: "sent", total: 550.25 },
          { id: "i3", title: "Cancelled job", status: "cancelled", total: 300 },
          { id: "i4", title: "Draft", status: "draft", total: null },
        ];
      }
      throw new Error(`unexpected SQL: ${s}`);
    });
    setLocalReads(fakeReads({ getAll }));

    const overview = await getCustomerOverview("c1");

    expect(overview).toEqual({
      jobs: [
        { id: "j1", job_number: 101, title: "Backflow test", status: "completed" },
        { id: "j2", job_number: 102, title: "Reticulation", status: "in_progress" },
      ],
      quotes: [{ id: "q1", title: "Pump replacement", status: "sent", total: 990.5 }],
      invoices: [
        { id: "i1", title: "March works", status: "paid", total: 1100 },
        { id: "i2", title: "April works", status: "sent", total: 550.25 },
        { id: "i3", title: "Cancelled job", status: "cancelled", total: 300 },
        { id: "i4", title: "Draft", status: "draft", total: null },
      ],
      // Sum of ALL invoices (incl. cancelled) vs not-paid-and-not-cancelled.
      totalInvoiced: 1950.25,
      outstanding: 550.25,
    });

    const calls = getAll.mock.calls.map(([sql, params]) => [norm(sql), params]);
    expect(calls).toEqual([
      ["SELECT id, job_number, title, status FROM jobs WHERE customer_id = ? ORDER BY created_at DESC", ["c1"]],
      ["SELECT id, title, status, total FROM quotes WHERE customer_id = ? ORDER BY created_at DESC", ["c1"]],
      ["SELECT id, title, status, total FROM invoices WHERE customer_id = ? ORDER BY created_at DESC", ["c1"]],
    ]);
  });
});

describe("role gate", () => {
  it("never touches the local DB for a technician — the remote (RLS-guarded) path is taken", async () => {
    const getAll = jest.fn();
    const getOptional = jest.fn();
    setLocalReads(fakeReads({ role: () => "technician", getAll, getOptional }));

    await listCustomers(0, 25);
    await getCustomer("c1");
    await getCustomerOverview("c1");

    expect(getAll).not.toHaveBeenCalled();
    expect(getOptional).not.toHaveBeenCalled();
    // The Supabase client was exercised instead.
    expect((supabase.from as jest.Mock).mock.calls.length).toBeGreaterThan(0);
  });
});
