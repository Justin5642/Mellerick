// Every lookup the local read layer makes must be able to use an index.
//
// PowerSync tables are views over one JSON table each; without an index a
// `WHERE job_id = ?` parses every row of the table, every time. The indexes are
// declared by hand in mobile/powersync/device-indexes.js (merged into the
// generated schema.ts). This suite closes the loop from the other side: it
// reads the SQL the reads actually run and fails when a lookup has no index
// whose LEADING column is the looked-up column.
//
// Scope, honestly stated: equality/range comparisons against a bind parameter
// (`col = ?`, `alias.col >= ?`) and correlated lookups (`n.job_id = j.id`) in
// the exported SQL_* statements of lib/data/reads, plus the one local query
// outside that directory (lib/location-tracking.tsx findOpenEntry). Lookups on
// the primary key (`id`) use PowerSync's own index. Small reference tables and
// low-cardinality flag columns are exempt by name below — a scan of a few
// hundred rows is not worth an index's write cost on every sync.
jest.mock("../supabase", () => {
  const chain: Record<string, unknown> = {};
  for (const m of ["from", "select", "eq", "in", "is", "not", "or", "gte", "lte", "order", "range", "limit", "single"]) {
    chain[m] = jest.fn(() => chain);
  }
  chain.then = (onFulfilled: (v: { data: null }) => unknown) => Promise.resolve({ data: null }).then(onFulfilled);
  return { supabase: chain };
});

import { readdirSync } from "fs";
import { join } from "path";
import { AppSchema } from "./schema";

const READS = join(__dirname, "..", "data", "reads");

// lib/location-tracking.tsx findOpenEntry — inline, not exported.
const EXTRA: Array<[string, string]> = [
  [
    "location-tracking.findOpenEntry",
    "SELECT id, clock_in FROM time_entries WHERE job_id = ? AND staff_id = ? AND entry_type = 'work' AND clock_out IS NULL LIMIT 1",
  ],
];

const SMALL_REFERENCE_TABLES = new Set([
  "profiles", "customers", "equipment", "pricing_items", "inventory", "variation_types",
  "backflow_devices", "sync_horizon",
]);
const LOW_CARDINALITY = new Set(["is_active", "status", "ready_to_invoice", "result", "entry_type"]);

// Lookups deliberately left to a scan, each with the reason an index would not
// be used or would not pay. Keyed `table.column`.
const SCAN_BY_DESIGN: Record<string, string> = {
  // searchOfficeJobs: `title LIKE '%q%' OR job_number = ?` — the OR with a
  // leading-wildcard LIKE forces a scan whatever is indexed.
  "jobs.job_number": "OR-ed with a %substring% LIKE",
  // getEquipmentUtilization: usage_date >= (12 months ago) over a table the
  // sync window already holds to 24 months — about half the rows match, where
  // a scan beats an index probe per row.
  "equipment_usage_log.usage_date": "range matching ~half of a windowed table",
};

function statements(): Array<[string, string]> {
  const out: Array<[string, string]> = [...EXTRA];
  for (const file of readdirSync(READS).sort()) {
    if (!file.endsWith(".ts") || file.includes(".test.")) continue;
    const mod = require(join(READS, file)) as Record<string, unknown>;
    for (const [name, value] of Object.entries(mod)) {
      if (name.startsWith("SQL_") && typeof value === "string") out.push([`${file.replace(/\.ts$/, "")}.${name}`, value]);
    }
  }
  return out;
}

const NOT_AN_ALIAS = new Set(["as", "on", "where", "order", "group", "limit", "join", "left", "inner", "and", "or"]);

function aliases(sql: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const [, table, alias] of sql.matchAll(/\b(?:FROM|JOIN)\s+([a-z_][a-z0-9_]*)(?:\s+(?:AS\s+)?([a-z_][a-z0-9_]*))?/gi)) {
    map.set(table, table);
    if (alias && !NOT_AN_ALIAS.has(alias.toLowerCase())) map.set(alias, table);
  }
  return map;
}

/** [table, column] for every lookup in a statement that needs an index. */
function lookups(sql: string): Array<[string, string]> {
  const byAlias = aliases(sql);
  const tables = [...new Set(byAlias.values())];
  const out: Array<[string, string]> = [];
  // qualified: a.col <op> ?   |   a.col = b.id (correlated / join lookup on a)
  for (const [, q, col] of sql.matchAll(/\b([a-z_]\w*)\.([a-z_]\w*)\s*(?:=|>=|<=|<|>)\s*(?:\?\d*|[a-z_]\w*\.id\b)/gi)) {
    const table = byAlias.get(q);
    if (table) out.push([table, col]);
  }
  // bare: col <op> ?  — attributable only when the statement has one table
  if (tables.length === 1) {
    for (const [, col] of sql.matchAll(/(?<![.\w])([a-z_]\w*)\s*(?:=|>=|<=|<|>)\s*\?\d*/gi)) out.push([tables[0], col]);
  }
  // IN (SELECT … FROM t WHERE …): the outer column is matched against t's ids
  for (const [, col] of sql.matchAll(/(?<![.\w])([a-z_]\w*)\s+IN\s*\(\s*SELECT\s+id\s+FROM/gi)) {
    if (tables.length >= 1) out.push([tables[0], col]);
  }
  return out.filter(([table, col]) => col !== "id" && !SMALL_REFERENCE_TABLES.has(table) && !LOW_CARDINALITY.has(col));
}

const INDEXES = new Map<string, string[][]>(
  AppSchema.tables.map((t) => [t.name, t.indexes.map((i) => i.columns.map((c) => c.name))])
);

/**
 * Is `col` usable through an index, given every column the same statement
 * looks up on that table? Leading column of some index, or a later column of
 * a composite whose earlier columns the statement also constrains — e.g.
 * scheduled_start under (assigned_to, scheduled_start) when assigned_to = ?.
 */
function covered(table: string, col: string, sameStatement: Set<string>): boolean {
  return (INDEXES.get(table) ?? []).some((cols) => {
    const at = cols.indexOf(col);
    return at >= 0 && cols.slice(0, at).every((c) => sameStatement.has(c));
  });
}

describe("device indexes", () => {
  it("validate as a PowerSync schema (every index column is declared)", () => {
    expect(() => AppSchema.validate()).not.toThrow();
  });

  const all = statements();

  it("found the read layer's SQL (vacuity guard)", () => {
    const total = all.reduce((n, [, sql]) => n + lookups(sql).length, 0);
    expect({ statements: all.length >= 45, lookups: total >= 20 }).toEqual({ statements: true, lookups: true });
  });

  it.each(all)("%s: every lookup has an index leading with its column", (_name, sql) => {
    const found = lookups(sql);
    const missing = found
      .filter(([table, col]) => !SCAN_BY_DESIGN[`${table}.${col}`])
      .filter(([table, col]) => !covered(table, col, new Set(found.filter(([t]) => t === table).map(([, c]) => c))))
      .map(([table, col]) => `${table}.${col}`);
    expect(missing).toEqual([]);
  });
});
