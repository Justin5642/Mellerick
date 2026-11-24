// The office Schedule tab's "Over allowed hours" read: money-free views and
// work time entries only, chunked and paged. A fake answers per table and
// honours .in() / .neq() / .range() so paging is exercised for real.
type Call = [string, ...unknown[]];
const tables: Record<string, Record<string, unknown>[]> = {};
const calls: { table: string; chain: Call[] }[] = [];
let failTable: string | null = null;

function mockBuilder(table: string) {
  const chain: Call[] = [];
  calls.push({ table, chain });
  let rows = [...(tables[table] ?? [])];
  let range: [number, number] = [0, 999];
  const b: Record<string, unknown> = {};
  b.select = (...a: unknown[]) => (chain.push(["select", ...a]), b);
  b.order = (...a: unknown[]) => (chain.push(["order", ...a]), b);
  b.in = (col: string, vals: unknown[]) => {
    chain.push(["in", col, vals.length]);
    rows = rows.filter((r) => vals.includes(r[col]));
    return b;
  };
  b.neq = (col: string, val: unknown) => {
    chain.push(["neq", col, val]);
    rows = rows.filter((r) => r[col] !== val);
    return b;
  };
  b.range = (from: number, to: number) => {
    chain.push(["range", from, to]);
    range = [from, to];
    return b;
  };
  b.then = (resolve: (v: unknown) => void) => {
    if (failTable === table) return Promise.resolve({ data: null, error: { message: "boom" } }).then(resolve);
    return Promise.resolve({ data: rows.slice(range[0], Math.min(range[1] + 1, range[0] + 1000)), error: null }).then(resolve);
  };
  return b;
}
jest.mock("../../supabase", () => ({ supabase: { from: (t: string) => mockBuilder(t) } }));

import { listJobHours, OVER_HOURS_ENTRY_COLUMNS, OVER_HOURS_LINE_COLUMNS, OVER_HOURS_PO_COLUMNS } from "./overHours";
import { bookingOverHours } from "../../overHours";

const NOW = Date.parse("2026-11-24T05:00:00Z");
const entry = (i: number, job_id: string, cost_center_id: string | null, hours: number, entry_type = "work") => ({
  id: `e${i}`,
  job_id,
  cost_center_id,
  hours,
  clock_in: "2026-11-20T21:00:00Z",
  clock_out: "2026-11-21T05:00:00Z",
  entry_type,
});

beforeEach(() => {
  for (const k of Object.keys(tables)) delete tables[k];
  calls.length = 0;
  failTable = null;
});

describe("listJobHours", () => {
  it("selects hours only, from the money-free views — never purchase_orders or po_cost_centers", async () => {
    for (const cols of [OVER_HOURS_PO_COLUMNS, OVER_HOURS_LINE_COLUMNS, OVER_HOURS_ENTRY_COLUMNS]) {
      expect(cols).not.toMatch(/amount|value|rate|price/i);
    }
    tables.purchase_orders_public = [{ id: "po1", job_id: "A", total_hours: 40 }];
    tables.po_cost_centers_public = [{ id: "drain", po_id: "po1", name: "Drainage", allocated_hours: "30" }];
    tables.time_entries = [entry(1, "A", "drain", 34), entry(2, "A", "drain", 50, "travel")];
    const hours = await listJobHours(["A"], NOW);
    expect(hours && bookingOverHours({ job_id: "A", cost_center_id: "drain" }, hours)?.text).toBe("Over hours: 34 h of 30 h (Drainage)");
    expect(calls.map((c) => c.table).sort()).toEqual(["po_cost_centers_public", "purchase_orders_public", "time_entries"]);
    expect(calls.find((c) => c.table === "time_entries")?.chain).toContainEqual(["neq", "entry_type", "travel"]);
  });

  it("pages past 1000 time entries", async () => {
    tables.purchase_orders_public = [{ id: "po1", job_id: "A", total_hours: 10 }];
    tables.time_entries = Array.from({ length: 2100 }, (_, i) => entry(i, "A", null, 1));
    const hours = await listJobHours(["A"], NOW);
    expect(hours?.A.usedHours).toBe(2100);
    expect(calls.filter((c) => c.table === "time_entries")).toHaveLength(3);
  });

  it("null when a read fails — the grid then shows no badges", async () => {
    failTable = "time_entries";
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    expect(await listJobHours(["A"], NOW)).toBeNull();
    warn.mockRestore();
  });

  it("asks nothing for no jobs", async () => {
    expect(await listJobHours([], NOW)).toEqual({});
    expect(calls).toHaveLength(0);
  });
});
