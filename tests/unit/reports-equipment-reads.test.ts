import { describe, it, expect, vi, beforeEach } from "vitest";
import React from "react";

// The reports page paged seven of its nine multi-row reads through fetchAllRows
// and left two behind: `equipment` and `equipment_usage_log`. Both destructured
// `data` only and fell back to `?? []`, so they carried BOTH failures the paging
// work was meant to end:
//
//   1. Silent truncation. equipment_usage_log gets one row per equipment use
//      across the whole fleet for twelve months, so it is the first table on
//      this page to cross PostgREST's 1000-row cap. Past it, hoursUsed
//      under-reports, utilizationPct under-reports with it, and
//      trueCostPerHourUsed — fixed cost divided by too-few hours — OVER-reports.
//      That last number is the entire point of the section: it is what the
//      own-versus-hire decision is made on.
//
//   2. A failed read reported as zero. `?? []` turns an error into "every item
//      did 0 hours", which renders as 0% utilisation and a null true cost —
//      indistinguishable from a fleet that sat idle all year.
//
// These tests drive the page function directly with a PostgREST-shaped fake, so
// they observe the reported numbers rather than the shape of the query.

vi.mock("@/components/reports/reports-dashboard", () => ({
  // Rendering is not what is under test; the props the page computes are.
  ReportsDashboard: () => null,
}));

const supabase = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => supabase.current,
}));

// tsconfig sets jsx: "preserve" because Next does its own JSX transform, so
// vitest's esbuild falls back to the classic `React.createElement` form — which
// needs a global React that a server component never imports. Supplying one
// here keeps the test working whichever transform esbuild picks, rather than
// depending on a build setting from another file.
(globalThis as { React?: unknown }).React = React;

const { default: ReportsPage } = await import("@/app/dashboard/reports/page");

type Row = Record<string, unknown>;

// What production actually does: an unranged select comes back capped at 1000
// rows with no error and no flag. A ranged one returns the window asked for.
const POSTGREST_CAP = 1000;

function tableStub(rows: Row[], error?: string) {
  const result = error ? { data: null, error: { message: error } } : null;
  const chain: Record<string, unknown> = {};
  for (const m of ["select", "eq", "gte", "lte", "not", "is", "order", "limit"]) {
    chain[m] = () => chain;
  }
  chain.single = async () => result ?? { data: rows[0] ?? null, error: null };
  chain.maybeSingle = chain.single;
  chain.range = async (from: number, to: number) =>
    result ?? { data: rows.slice(from, to + 1), error: null };
  // Thenable, so `await client.from(x).select(y)` behaves like the real thing:
  // silently capped.
  chain.then = (resolve: (v: unknown) => unknown) =>
    resolve(result ?? { data: rows.slice(0, POSTGREST_CAP), error: null });
  return chain;
}

function fakeClient(tables: Record<string, { rows?: Row[]; error?: string }>) {
  return {
    auth: { getUser: async () => ({ data: { user: null }, error: null }) },
    from: (name: string) => tableStub(tables[name]?.rows ?? [], tables[name]?.error),
  };
}

/** One item whose fixed costs are $10,000/yr against a 1000-hour target. */
function equipmentItem(id: string): Row {
  return {
    id,
    name: `Item ${id}`,
    is_active: true,
    assigned_to: null,
    purchase_cost: 100_000,
    estimated_life_years: 10,
    insurance_annual: 0,
    maintenance_annual: 0,
    registration_annual: 0,
    other_annual_costs: 0,
    fuel_cost_per_hour: 0,
    target_hours_per_year: 1000,
  };
}

/** Recursively collect the text of a rendered element tree. */
function textOf(node: unknown): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  const props = (node as { props?: { children?: unknown } }).props;
  return props ? textOf(props.children) : "";
}

async function renderPage(tables: Record<string, { rows?: Row[]; error?: string }>) {
  supabase.current = fakeClient(tables);
  return (await ReportsPage()) as {
    props: { equipmentUtilization?: { name: string; hoursUsed: number; utilizationPct: number | null; trueCostPerHourUsed: number | null }[] };
  };
}

describe("reports page equipment reads", () => {
  beforeEach(() => {
    supabase.current = null;
  });

  it("counts every logged hour, not just the first page of the usage log", async () => {
    // 1500 entries of 2 hours against one item = 3000 hours. Truncated at the
    // cap it would be 2000 — a third of the year's use missing, and a true cost
    // per hour inflated by half.
    const usage = Array.from({ length: 1500 }, () => ({
      equipment_id: "eq-1",
      hours: 2,
      usage_date: "2026-01-01",
    }));

    const page = await renderPage({
      equipment: { rows: [equipmentItem("eq-1")] },
      equipment_usage_log: { rows: usage },
    });

    const item = page.props.equipmentUtilization?.[0];
    expect(item?.hoursUsed).toBe(3000);
    expect(item?.utilizationPct).toBe(300);
    expect(item?.trueCostPerHourUsed).toBeCloseTo(10_000 / 3000, 10);
  });

  it("reports every active item, not just the first page of the fleet", async () => {
    const fleet = Array.from({ length: 1200 }, (_, i) => equipmentItem(`eq-${i}`));

    const page = await renderPage({
      equipment: { rows: fleet },
      equipment_usage_log: { rows: [] },
    });

    expect(page.props.equipmentUtilization).toHaveLength(1200);
  });

  it("says the usage log could not be read instead of reporting zero hours", async () => {
    const page = await renderPage({
      equipment: { rows: [equipmentItem("eq-1")] },
      equipment_usage_log: { error: "permission denied for table equipment_usage_log" },
    });

    expect(page.props.equipmentUtilization).toBeUndefined();
    expect(textOf(page)).toMatch(/could not be calculated from complete data/i);
    expect(textOf(page)).toMatch(/permission denied for table equipment_usage_log/);
  });

  it("says the fleet could not be read instead of reporting an empty fleet", async () => {
    const page = await renderPage({
      equipment: { error: "permission denied for table equipment" },
      equipment_usage_log: { rows: [] },
    });

    expect(page.props.equipmentUtilization).toBeUndefined();
    expect(textOf(page)).toMatch(/permission denied for table equipment/);
  });
});
