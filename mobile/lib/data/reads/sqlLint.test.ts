// Every column the offline read layer names must exist on the device.
//
// THE DEFECT THIS EXISTS FOR, which shipped and was found by inspection rather
// than by any test:
//
//   migration 0040 added jobs.ready_to_invoice
//   office_jobs syncs `SELECT jobs.*`, so it replicates
//   lib/data/reads/finance.ts:169 runs `WHERE j.ready_to_invoice = 1` LOCALLY
//   lib/powersync/schema.ts did not declare it — the generator was never re-run
//
// PowerSync builds the device view from the DECLARED columns, so that query
// raised "no such column". reads/source.ts:129-134 catches every local failure
// and falls back to Supabase — deliberately, so a bad read cannot take a screen
// down — and the warning is __DEV__-gated. So in production the screen worked
// online, was permanently broken offline, and reported nothing either way. In
// an offline-first app for technicians in basements, that is the failure that
// matters.
//
// WHY NOTHING CAUGHT IT. schema.test.ts compares the device schema against the
// streams file, but skips wildcard tables outright — `if (cols === "ALL")
// continue;` — and all 18 office_* streams are `SELECT <table>.*`. So the only
// test comparing device schema to streams exempts exactly the tables where the
// column list is not written down. schema-column-contract.test.ts parses
// PostgREST chains against the migrations and never sees raw SQL run against
// AppSchema.
//
// This closes it from the other end. It does not care what the streams say: it
// asks whether the columns the app READS are columns the device HAS. That
// question is answerable with no database, no network and no stack, so it runs
// in the ordinary mobile CI job.
import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import { AppSchema } from "../../powersync/schema";

const READS_DIR = __dirname;

// PowerSync declares `id` implicitly on every table — schema.ts does not list
// it (see its "// id (text) is implicit" comment), but the device view has it.
const IMPLICIT = new Set(["id"]);

const deviceColumns = new Map(
  AppSchema.tables.map((t) => [t.name, new Set([...t.columns.map((c) => c.name), ...IMPLICIT])])
);

/**
 * Words that can follow FROM/JOIN but are not an alias. Without this, `FROM
 * jobs LEFT JOIN ...` would bind the alias "LEFT" to the table "jobs" and then
 * silently resolve nothing, which is the failure mode where a guard looks green
 * because it checked nothing.
 */
const NOT_AN_ALIAS = new Set([
  "on", "where", "left", "right", "inner", "outer", "full", "cross", "join",
  "group", "order", "limit", "having", "union", "and", "or", "as", "using",
]);

/** alias -> table, for every FROM/JOIN in one query (subqueries included). */
function aliasMap(sql: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const m of sql.matchAll(/\b(?:from|join)\s+([a-z_][a-z0-9_]*)\s*(?:as\s+)?([a-z][a-z0-9_]*)?/gi)) {
    const table = m[1].toLowerCase();
    const maybeAlias = m[2]?.toLowerCase();
    const alias = maybeAlias && !NOT_AN_ALIAS.has(maybeAlias) ? maybeAlias : table;
    map.set(alias, table);
    // `FROM jobs j` — the bare table name is still usable as a qualifier.
    map.set(table, table);
  }
  return map;
}

/** Every `alias.column` reference in one query. */
function dottedRefs(sql: string): Array<{ alias: string; column: string }> {
  return [...sql.matchAll(/\b([a-z][a-z0-9_]*)\.([a-z_][a-z0-9_]*)\b/gi)].map((m) => ({
    alias: m[1].toLowerCase(),
    column: m[2].toLowerCase(),
  }));
}

/**
 * The exported `SQL_*` template literals — the queries that run on-device.
 *
 * Some are composed from a shared fragment, e.g. fleet.ts builds
 * SQL_LIST_EQUIPMENT as `${EQUIPMENT_PROJECTION} WHERE …`, and the FROM clause
 * lives in that fragment. Interpolations are inlined from constants in the same
 * file, or the query would appear to reference tables it never declares — and
 * every column in it would be skipped as unresolvable, silently.
 */
function localQueries(): Array<{ file: string; name: string; sql: string }> {
  const out: Array<{ file: string; name: string; sql: string }> = [];
  for (const file of readdirSync(READS_DIR).filter((f) => f.endsWith(".ts") && !f.includes(".test."))) {
    const src = readFileSync(join(READS_DIR, file), "utf8");

    const fragments = new Map<string, string>();
    for (const m of src.matchAll(/(?:export )?const ([A-Z][A-Z0-9_]*)\s*=\s*`([^`]*)`/g)) {
      fragments.set(m[1], m[2]);
    }

    const inline = (sql: string, depth = 0): string =>
      depth > 4
        ? sql
        : sql.replace(/\$\{([A-Z][A-Z0-9_]*)\}/g, (whole, ref) =>
            fragments.has(ref) ? inline(fragments.get(ref)!, depth + 1) : whole
          );

    for (const m of src.matchAll(/export const (SQL_[A-Z0-9_]+)\s*=\s*`([^`]*)`/g)) {
      out.push({ file, name: m[1], sql: inline(m[2]) });
    }
  }
  return out;
}

describe("offline reads only name columns the device actually has", () => {
  const queries = localQueries();

  it("finds the local queries at all", () => {
    // A parser that silently matches nothing would make every assertion below
    // pass while checking nothing — the shape .github/workflows/ci.yml:179-185
    // added a migration-count assertion to prevent, for the same reason.
    expect(queries.length).toBeGreaterThan(20);
    expect(new Set(queries.map((q) => q.file)).size).toBeGreaterThan(5);
  });

  it("resolves table aliases rather than skipping them", () => {
    // Same guard, one level down: if aliasMap stopped resolving, every dotted
    // reference would become "unknown alias" and be skipped as unresolvable.
    const resolved = queries.filter((q) => aliasMap(q.sql).size > 0);
    expect(resolved.length).toBe(queries.length);
  });

  // A multi-table query that qualifies NOTHING cannot be attributed to a table,
  // so every column in it is skipped — silently, and by design, since guessing
  // which of two tables owns a bare column name would produce false failures.
  //
  // That skip is the guard's blind spot, so the two queries in it are named
  // here rather than filtered by a rule. A committed literal means a THIRD one
  // appearing is a visible coverage loss that fails this test, instead of being
  // quietly absorbed into an exemption nobody re-reads.
  const UNATTRIBUTABLE = [
    "backflow.ts::SQL_LIST_BACKFLOW_TESTS",
    "jobBilling.ts::SQL_JOB_BILLING_PO_COST_CENTERS",
  ];

  it("has not quietly grown its own blind spot", () => {
    const unattributable = queries
      .filter((q) => {
        const tables = [...q.sql.matchAll(/\b(?:from|join)\s+[a-z_][a-z0-9_]*/gi)];
        return tables.length > 1 && dottedRefs(q.sql).length === 0;
      })
      .map((q) => `${q.file}::${q.name}`)
      .sort();

    expect(unattributable).toEqual([...UNATTRIBUTABLE].sort());
  });

  it("names no column the device schema lacks", () => {
    const missing: string[] = [];

    for (const { file, name, sql } of queries) {
      const aliases = aliasMap(sql);
      for (const { alias, column } of dottedRefs(sql)) {
        const table = aliases.get(alias);
        if (!table) continue; // not a table qualifier (a function call, a cast)
        const cols = deviceColumns.get(table);
        if (!cols) continue; // table isn't synced at all — a different test's job
        if (!cols.has(column)) {
          missing.push(`${file} ${name}: ${table}.${column} (via "${alias}")`);
        }
      }
    }

    // Deliberately reported as a list rather than one at a time: a regenerate
    // that misses several columns should show all of them, not the first.
    expect(missing).toEqual([]);
  });
});
