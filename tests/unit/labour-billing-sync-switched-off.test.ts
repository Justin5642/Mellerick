import { describe, it, expect } from "vitest";
import { syncJobBilling } from "@/lib/labour-billing-sync";

// Automatic labour lines are off company-wide (migration 0086; Justin, 31 Oct
// 2026: "Never automatic"). With the switch off, a sync must not add, reprice
// or delete anything — lines already on a job are the office's to keep or
// remove. A database without 0086 (no column) keeps the old behaviour.

const ENTRY = {
  id: "te-1",
  staff_id: "staff-1",
  clock_in: "2026-10-30T22:00:00.000Z",
  clock_out: "2026-10-31T01:00:00.000Z",
  entry_type: "work",
  rate_override: null,
};

type Call = { table: string; op: "insert" | "update" | "delete" };

function fakeAdmin(config: Record<string, unknown> | null, rows: Record<string, unknown[]>, calls: Call[]) {
  const make = (table: string) => {
    let pending: Call | null = null;
    const builder: Record<string, unknown> = {};
    for (const m of ["select", "eq", "in", "order", "upsert"]) builder[m] = () => builder;
    for (const op of ["insert", "update", "delete"] as const) {
      builder[op] = () => {
        pending = { table, op };
        return builder;
      };
    }
    builder.maybeSingle = () => Promise.resolve({ data: table === "billing_rate_config" ? config : null, error: null });
    builder.then = (resolve: (v: unknown) => unknown) => {
      if (pending) calls.push(pending);
      return resolve({ data: pending ? null : rows[table] ?? [], error: null });
    };
    return builder;
  };
  return { from: (table: string) => make(table) } as never;
}

const STORED = [
  { id: "li-1", source: "auto_labour", time_entry_id: "te-gone", staff_id: "staff-1", name: "Labour", description: "3h", quantity: 3, unit_price: 130 },
  { id: "li-2", source: "auto_callout", time_entry_id: null, staff_id: null, name: "Call Out Fee", description: "", quantity: 1, unit_price: 180 },
];

describe("syncJobBilling with automatic labour lines switched off", () => {
  it("adds nothing, reprices nothing and deletes nothing", async () => {
    const calls: Call[] = [];
    const result = await syncJobBilling(
      fakeAdmin({ auto_labour_lines: false, qualified_base_rate: 130 }, { time_entries: [ENTRY], job_items: STORED }, calls),
      "job-1"
    );
    expect(calls).toEqual([]);
    expect(result).toMatchObject({ labourItems: 0, disabled: true });
  });

  it("still adds lines on a database without the switch", async () => {
    const calls: Call[] = [];
    await syncJobBilling(fakeAdmin(null, { time_entries: [ENTRY], job_items: [] }, calls), "job-1");
    expect(calls.some((c) => c.table === "job_items" && c.op === "insert")).toBe(true);
  });
});
