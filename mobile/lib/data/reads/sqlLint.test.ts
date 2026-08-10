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
// SCOPE, honestly stated: only QUALIFIED references (`alias.column`) are
// checked, because those are the ones a table can be resolved for without a
// real SQL parser. Bare columns in single-table queries are not covered, and
// neither is anything built at runtime rather than in a module-level const.
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

/** Returns [complaints, number of qualified refs actually resolved]. */
function lint(sql: string): [string[], number] {
  const byQualifier = qualifiers(sql);
  const bad: string[] = [];
  let checked = 0;
  for (const [, qualifier, col] of sql.matchAll(/\b([a-z_][a-z0-9_]*)\.([a-z_][a-z0-9_]*)/gi)) {
    const table = byQualifier.get(qualifier);
    if (!table) {
      bad.push(`${qualifier}.${col} — no FROM/JOIN introduces "${qualifier}"`);
      continue;
    }
    const cols = SCHEMA.get(table);
    if (!cols) {
      bad.push(`${qualifier}.${col} — table "${table}" is not in AppSchema`);
      continue;
    }
    checked++;
    if (!cols.has(col)) bad.push(`${qualifier}.${col} — "${table}" has no column "${col}"`);
  }
  return [bad, checked];
}

describe("local SQL references only columns the device schema declares", () => {
  const statements = exportedSql();

  it.each(statements)("%s", (_name, sql) => {
    expect(lint(sql)[0]).toEqual([]);
  });

  // Without this the suite passes vacuously if the const scan or the reference
  // regex ever stops matching. 231 qualified references at the time of writing.
  it("actually resolved a meaningful number of references", () => {
    const total = statements.reduce((n, [, sql]) => n + lint(sql)[1], 0);
    expect({ statements: statements.length >= 45, references: total >= 200 }).toEqual({
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
      .filter(([, sql]) => {
        const tables = [...sql.matchAll(/\b(?:from|join)\s+[a-z_][a-z0-9_]*/gi)].length;
        return tables > 1 && lint(sql)[1] === 0;
      })
      .map(([name]) => name)
      .sort();

    expect(blind).toEqual([...UNATTRIBUTABLE].sort());
  });
});
