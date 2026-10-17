import { describe, it, expect } from "vitest";
import { syncJobBilling } from "@/lib/labour-billing-sync";

// syncJobBilling runs every time the Line Items tab opens. It used to rewrite
// every auto labour line on every open, one round trip at a time, even when
// nothing had changed. These pin that an unchanged line is left alone while a
// changed one is still rewritten — skipping too much would leave a stale price.

const ENTRY = {
  id: "te-1",
  staff_id: "staff-1",
  clock_in: "2026-08-05T09:00:00.000Z",
  clock_out: "2026-08-05T12:00:00.000Z",
  entry_type: "work",
  rate_override: null,
};

type Call = { table: string; op: "insert" | "update"; payload: Record<string, unknown> };

function recordingAdmin(rows: Record<string, unknown[]>, calls: Call[]) {
  const make = (table: string) => {
    let pending: Call | null = null;
    const builder: Record<string, unknown> = {};
    for (const m of ["select", "eq", "in", "order", "delete", "upsert"]) builder[m] = () => builder;
    builder.insert = (payload: Record<string, unknown>) => {
      pending = { table, op: "insert", payload };
      return builder;
    };
    builder.update = (payload: Record<string, unknown>) => {
      pending = { table, op: "update", payload };
      return builder;
    };
    builder.maybeSingle = () => Promise.resolve({ data: null, error: null });
    builder.single = builder.maybeSingle;
    builder.then = (resolve: (v: unknown) => unknown) => {
      if (pending) calls.push(pending);
      return resolve({ data: pending ? null : rows[table] ?? [], error: null });
    };
    return builder;
  };
  return { from: (table: string) => make(table) } as never;
}

async function firstLabourRow() {
  const calls: Call[] = [];
  await syncJobBilling(recordingAdmin({ time_entries: [ENTRY], job_items: [] }, calls), "job-1");
  const insert = calls.find((c) => c.table === "job_items" && c.op === "insert" && c.payload.source === "auto_labour");
  expect(insert, "fixture: first sync should insert a labour line").toBeDefined();
  return insert!.payload;
}

describe("syncJobBilling — opening Line Items does not rewrite unchanged lines", () => {
  it("makes no labour update when the stored line already matches", async () => {
    const stored = { id: "li-1", ...(await firstLabourRow()) };
    const calls: Call[] = [];
    await syncJobBilling(recordingAdmin({ time_entries: [ENTRY], job_items: [stored] }, calls), "job-1");
    expect(calls.filter((c) => c.table === "job_items" && c.op === "update")).toHaveLength(0);
  });

  it("still rewrites a line whose price has drifted", async () => {
    const stored = { id: "li-1", ...(await firstLabourRow()), unit_price: 1 };
    const calls: Call[] = [];
    await syncJobBilling(recordingAdmin({ time_entries: [ENTRY], job_items: [stored] }, calls), "job-1");
    expect(calls.filter((c) => c.table === "job_items" && c.op === "update")).toHaveLength(1);
  });

  it("treats numeric strings from PostgREST as equal numbers", async () => {
    const row = await firstLabourRow();
    const stored = { id: "li-1", ...row, quantity: String(row.quantity), unit_price: String(row.unit_price) };
    const calls: Call[] = [];
    await syncJobBilling(recordingAdmin({ time_entries: [ENTRY], job_items: [stored] }, calls), "job-1");
    expect(calls.filter((c) => c.table === "job_items" && c.op === "update")).toHaveLength(0);
  });
});
