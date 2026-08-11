// The guard finance.ts:119 has been promising since the local reads landed:
// every qualified column in the hand-written local SQL must exist in the
// generated device schema.
//
// WHY IT IS NEEDED: PowerSync device tables are SQLite views built from
// AppSchema, so a column the schema does not declare is simply absent from the
// view and the query dies with "no such column". source.ts catches that and
// falls back to Supabase — silently in production (the console.warn is __DEV__
// only). Online everything looks right; OFFLINE the screen is broken, which is
// the one case the mirror exists for. That is exactly how jobs.ready_to_invoice
// (migration 0040) shipped: the generator was never re-run.
//
// The per-module *.local.test.ts files cannot catch it — they assert the SQL
// string against a fake LocalReads Map, which accepts any column name.
//
// SCOPE, honestly stated: QUALIFIED references (`alias.column`) are checked
// everywhere, and BARE columns are checked in statements with a single table,
// where there is nothing to resolve them against but that one table. Bare
// columns in a multi-table statement are not covered — guessing which of two
// tables owns one would invent failures — and neither is anything built at
// runtime rather than in a module-level const.
//
// It reads the exported consts rather than the source text on purpose: fleet.ts
// composes SQL by interpolating EQUIPMENT_PROJECTION, so a source-text scan
// never sees its FROM clause.
jest.mock("../../supabase", () => {
  const chain: Record<string, unknown> = {};
  for (const m of ["from", "select", "eq", "in", "is", "not", "or", "gte", "lte", "order", "range", "limit", "single"]) {
    chain[m] = jest.fn(() => chain);
  }
  chain.then = (onFulfilled: (v: { data: null }) => unknown, onRejected?: (e: unknown) => unknown) =>
    Promise.resolve({ data: null }).then(onFulfilled, onRejected);
  return { supabase: chain };
});

import { readdirSync } from "fs";
import { join } from "path";
import { AppSchema } from "../../powersync/schema";

/** table -> declared columns. `id` is implicit in PowerSync, not in `columns`. */
const SCHEMA = new Map(
  AppSchema.tables.map((t) => [t.name, new Set<string>(["id", ...t.columns.map((c) => c.name)])])
);

/** Every `SQL_*` string exported by a read module, keyed `module.CONST`. */
function exportedSql(): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const file of readdirSync(__dirname).sort()) {
    if (!file.endsWith(".ts") || file.includes(".test.")) continue;
    const mod = require(join(__dirname, file)) as Record<string, unknown>;
    for (const [name, value] of Object.entries(mod)) {
      if (name.startsWith("SQL_") && typeof value === "string") out.push([`${file.replace(/\.ts$/, "")}.${name}`, value]);
    }
  }
  return out;
}

// Words that can follow a table name where an alias would sit; without this the
// `t` in `FROM jobs WHERE …` would be read as an alias called "where".
const NOT_AN_ALIAS = new Set([
  "as", "on", "where", "order", "group", "having", "limit", "offset", "union",
  "join", "left", "right", "inner", "outer", "cross", "natural", "using", "and", "or",
]);

/** qualifier (alias or bare table name) -> table, for one statement. */
function qualifiers(sql: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const [, table, alias] of sql.matchAll(
    /\b(?:FROM|JOIN)\s+([a-z_][a-z0-9_]*)(?:\s+(?:AS\s+)?([a-z_][a-z0-9_]*))?/gi
  )) {
    map.set(table, table); // correlated subqueries qualify by table name
    if (alias && !NOT_AN_ALIAS.has(alias.toLowerCase())) map.set(alias, table);
  }
  return map;
}

// Only FROM/JOIN introduce a table here, so `FROM a, b` would read as one table
// and b's columns would be blamed on a. Refusing to attribute such a statement
// turns that into a visible coverage gap below, which is the safe direction —
// an invented "has no column" failure sends someone hunting a schema bug that
// is not there.
const COMMA_JOIN = /\bFROM\s+[a-z_][a-z0-9_]*(?:\s+(?:AS\s+)?[a-z_][a-z0-9_]*)?\s*,/i;

/** The one table a bare column can only belong to, or null if it is ambiguous. */
function soleTable(sql: string): string | null {
  const tables = [...sql.matchAll(/\b(?:FROM|JOIN)\s+([a-z_][a-z0-9_]*)/gi)].map((m) => m[1]);
  return tables.length === 1 && !COMMA_JOIN.test(sql) ? tables[0] : null;
}

// Words that stand where a bare column would but name no column. Function names
// are not listed: they are removed by the `ident(` rule in bareColumns, so a
// column that happens to share a name with a SQL function still gets checked.
const NOT_A_COLUMN = new Set([
  "select", "from", "where", "group", "having", "order", "by", "limit", "offset",
  "and", "or", "not", "is", "null", "like", "in", "between", "exists", "escape",
  "collate", "nocase", "binary", "rtrim", "as", "distinct", "all", "union",
  "case", "when", "then", "else", "end", "asc", "desc", "nulls", "first", "last",
  "join", "on", "left", "right", "inner", "outer", "cross", "natural", "using",
  "with", "recursive", "over", "partition", "window", "cast", "true", "false",
]);

/** Bare (unqualified) column references in a statement. */
function bareColumns(sql: string): string[] {
  const stripped = sql
    .replace(/'(?:[^']|'')*'/g, " ") // literals: 'paid' is a value, not a column
    .replace(/\b[a-z_][a-z0-9_]*\s*\(/gi, " (") // ROUND(, COUNT(
    .replace(/\b[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*/gi, " ") // already checked as qualified
    .replace(/\bAS\s+[a-z_][a-z0-9_]*/gi, " ") // result aliases name no column
    .replace(/\b(?:FROM|JOIN)\s+[a-z_][a-z0-9_]*/gi, " ");
  return [...stripped.matchAll(/[a-z_][a-z0-9_]*/gi)]
    .map(([w]) => w)
    .filter((w) => !NOT_A_COLUMN.has(w.toLowerCase()));
}

/** Returns [complaints, number of references actually resolved]. */
function lint(sql: string): [string[], number] {
  const byQualifier = qualifiers(sql);
  const bad: string[] = [];
  let checked = 0;

  const check = (ref: string, table: string, col: string) => {
    const cols = SCHEMA.get(table);
    if (!cols) {
      bad.push(`${ref} — table "${table}" is not in AppSchema`);
      return;
    }
    checked++;
    if (!cols.has(col)) bad.push(`${ref} — "${table}" has no column "${col}"`);
  };

  for (const [, qualifier, col] of sql.matchAll(/\b([a-z_][a-z0-9_]*)\.([a-z_][a-z0-9_]*)/gi)) {
    const table = byQualifier.get(qualifier);
    if (!table) {
      bad.push(`${qualifier}.${col} — no FROM/JOIN introduces "${qualifier}"`);
      continue;
    }
    check(`${qualifier}.${col}`, table, col);
  }

  const sole = soleTable(sql);
  if (sole) for (const col of bareColumns(sql)) check(col, sole, col);

  return [bad, checked];
}

// The lint is the guard, so it needs its own guard: these synthetic statements
// pin the behaviours the real ones depend on but cannot demonstrate — they are
// all currently clean, so a lint that quietly stopped resolving anything would
// still pass the suite below.
describe("the lint itself", () => {
  it("catches a bare column the sole table does not declare", () => {
    expect(lint("SELECT id, nope FROM inventory")[0]).toEqual([
      `nope — "inventory" has no column "nope"`,
    ]);
  });

  it("counts bare columns of the sole table as resolved", () => {
    expect(lint("SELECT id, sku FROM inventory")).toEqual([[], 2]);
  });

  it("does not attribute bare columns when two tables could own them", () => {
    expect(
      lint("SELECT nope FROM jobs j JOIN customers c ON j.customer_id = c.id")
    ).toEqual([[], 2]);
  });

  it("does not mistake a result alias or a string literal for a column", () => {
    expect(lint("SELECT COUNT(*) AS nope FROM jobs WHERE status = 'nope'")).toEqual([[], 1]);
  });
});

describe("local SQL references only columns the device schema declares", () => {
  const statements = exportedSql();

  it.each(statements)("%s", (_name, sql) => {
    expect(lint(sql)[0]).toEqual([]);
  });

  // Without this the suite passes vacuously if the const scan or the reference
  // regex ever stops matching. 471 references at the time of writing — 271
  // qualified plus 200 bare columns in single-table statements.
  it("actually resolved a meaningful number of references", () => {
    const total = statements.reduce((n, [, sql]) => n + lint(sql)[1], 0);
    expect({ statements: statements.length >= 45, references: total >= 410 }).toEqual({
      statements: true,
      references: true,
    });
  });

  // The count above proves the guard is working IN AGGREGATE. It cannot show
  // that a PARTICULAR query is unchecked — and a multi-table query that
  // qualifies nothing is exactly that: every column in it skipped, silently,
  // while the total stays healthy because 45 other queries carry it.
  //
  // Skipping them is right (guessing which of two tables owns a bare column
  // would invent failures); skipping them invisibly is not. Naming them makes a
  // THIRD one a visible coverage loss that fails here, rather than being
  // absorbed into an aggregate that never notices.
  const UNATTRIBUTABLE = [
    "backflow.SQL_LIST_BACKFLOW_TESTS",
    "jobBilling.SQL_JOB_BILLING_PO_COST_CENTERS",
  ];

  it("has not quietly grown its own blind spot", () => {
    const blind = statements
      .filter(([, sql]) => lint(sql)[1] === 0)
      .map(([name]) => name)
      .sort();

    expect(blind).toEqual([...UNATTRIBUTABLE].sort());
  });
});
