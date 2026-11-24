import { describe, it, expect } from "vitest";
import {
  loadJobHours,
  OVER_HOURS_CHUNK,
  OVER_HOURS_ENTRY_COLUMNS,
  OVER_HOURS_LINE_COLUMNS,
  OVER_HOURS_PO_COLUMNS,
  type OverHoursClient,
} from "@/lib/over-hours-data";

type Call = { table: string; columns: string; filters: string[]; range?: [number, number] };

/** A fake PostgREST: serves `tables[table]` filtered by .in(), paged by .range() at `cap` rows. */
function fakeClient(tables: Record<string, Record<string, unknown>[]>, cap = 1000, fail?: string) {
  const calls: Call[] = [];
  const client = {
    from(table: string) {
      return {
        select(columns: string, opts?: { count?: "exact" }) {
          const call: Call = { table, columns, filters: [] };
          calls.push(call);
          let rows = [...(tables[table] ?? [])];
          const q = {
            in(column: string, values: readonly string[]) {
              call.filters.push(`in:${column}:${values.length}`);
              rows = rows.filter((r) => values.includes(r[column] as string));
              return q;
            },
            neq(column: string, value: string) {
              call.filters.push(`neq:${column}:${value}`);
              rows = rows.filter((r) => r[column] !== value);
              return q;
            },
            order(column: string) {
              call.filters.push(`order:${column}`);
              return q;
            },
            range(from: number, to: number) {
              call.range = [from, to];
              if (fail === table) return Promise.resolve({ data: null, error: { message: "boom" }, count: null });
              const page = rows.slice(from, Math.min(to + 1, from + cap));
              return Promise.resolve({ data: page, error: null, count: opts?.count ? rows.length : null });
            },
          };
          return q;
        },
      };
    },
  };
  return { client: client as unknown as OverHoursClient, calls };
}

const NOW = Date.parse("2026-11-24T05:00:00Z");
const entry = (job_id: string, cost_center_id: string | null, hours: number, i: number, entry_type = "work") => ({
  id: `e${i}`,
  job_id,
  cost_center_id,
  hours,
  clock_in: "2026-11-20T21:00:00Z",
  clock_out: "2026-11-21T05:00:00Z",
  entry_type,
});

describe("loadJobHours", () => {
  it("selects hours only — never an amount, value or rate column", () => {
    for (const cols of [OVER_HOURS_PO_COLUMNS, OVER_HOURS_LINE_COLUMNS, OVER_HOURS_ENTRY_COLUMNS]) {
      expect(cols).not.toMatch(/amount|value|rate|price|cost(?!_center)/i);
    }
  });

  it("reads the money-free views and the jobs' work entries, and adds them up", async () => {
    const { client, calls } = fakeClient({
      purchase_orders_public: [{ id: "po1", job_id: "A", total_hours: 40 }],
      po_cost_centers_public: [{ id: "drain", po_id: "po1", name: "Drainage", allocated_hours: 30 }],
      time_entries: [entry("A", "drain", 34, 1), entry("A", "drain", 99, 2, "travel"), entry("Z", null, 5, 3)],
    });
    const hours = await loadJobHours(client, ["A"], NOW);
    expect(hours?.A.usedHours).toBe(34);
    expect(hours?.A.lines.drain).toEqual({ name: "Drainage", usedHours: 34, allowedHours: 30 });
    expect(hours?.Z).toBeUndefined();
    expect(new Set(calls.map((c) => c.table))).toEqual(new Set(["purchase_orders_public", "po_cost_centers_public", "time_entries"]));
    expect(calls.find((c) => c.table === "time_entries")?.filters).toContain("neq:entry_type:travel");
  });

  it("pages past PostgREST's 1000-row cap and chunks the ids", async () => {
    const jobIds = Array.from({ length: OVER_HOURS_CHUNK + 5 }, (_, i) => `job${i}`);
    const entries = Array.from({ length: 2500 }, (_, i) => entry("job0", null, 1, i));
    const { client, calls } = fakeClient({ purchase_orders_public: [{ id: "po", job_id: "job0", total_hours: 10 }], po_cost_centers_public: [], time_entries: entries });
    const hours = await loadJobHours(client, jobIds, NOW);
    expect(hours?.job0.usedHours).toBe(2500);
    const entryCalls = calls.filter((c) => c.table === "time_entries");
    // Two chunks of ids (100 + 5); the first chunk takes three pages.
    expect(entryCalls.map((c) => c.filters[0])).toContain(`in:job_id:${OVER_HOURS_CHUNK}`);
    expect(entryCalls.map((c) => c.filters[0])).toContain("in:job_id:5");
    expect(entryCalls.length).toBe(4);
  });

  it("answers null (no badges) when a read fails, never a partial total", async () => {
    const { client } = fakeClient({ purchase_orders_public: [], po_cost_centers_public: [], time_entries: [] }, 1000, "time_entries");
    const original = console.error;
    console.error = () => {};
    try {
      expect(await loadJobHours(client, ["A"], NOW)).toBeNull();
    } finally {
      console.error = original;
    }
  });

  it("asks nothing for no jobs", async () => {
    const { client, calls } = fakeClient({});
    expect(await loadJobHours(client, [], NOW)).toEqual({});
    expect(calls).toHaveLength(0);
  });
});
