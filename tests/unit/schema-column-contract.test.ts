import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { referencedColumns } from "../helpers/column-references";
import { migrationTables } from "../helpers/migration-schema";

// Drift guard born from a real production bug (2026-07-28): `jobs.ready_to_invoice`
// was referenced by NINE call sites across web and mobile — including the web's
// Ready-to-Invoice queue and job sign-off — and existed in no migration and in no
// database. Postgres rejects a statement naming an unknown column, so those reads
// and writes had been failing in production, and a source comment asserting the
// column was "confirmed boolean in prod" is what let it survive review.
//
// Nothing in the test suite could catch it, because every test mocked Supabase —
// a mock happily accepts a column that does not exist. This test closes that gap
// by checking source against the canonical schema instead of against a mock.
//
// SCOPE, honestly stated: this parses `.eq("col", …)` / `.update({ col: … })` /
// `.insert({ col: … })` — including shorthand keys — on a chain naming a known
// table. It will not catch every possible reference (dynamic column names,
// spread payloads, RPC arguments), so it is a high-value net, not a proof.
//
// It covers EVERY table in the migration history, derived rather than listed.
// It also only sees columns the SOURCE names; a column that exists in production
// and in no migration is invisible here by construction — `npm run check:drift`
// is the check for that direction.

const REPO = join(__dirname, "..", "..");
const MIGRATIONS = join(REPO, "supabase", "migrations");

/**
 * The canonical schema is the ORDERED migration history, not the migration history
 * — that file is only the 0000 baseline, so tables added later (job_variations,
 * job_expenses, backflow_*) are absent from it.
 */
function migrationSql(): string {
  return readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => readFileSync(join(MIGRATIONS, f), "utf8"))
    .join("\n");
}

/**
 * Tables exempt from the check, with the reason. Everything else in the
 * migration history is covered automatically — a hardcoded allow-list is how a
 * guard silently stops guarding as the schema grows.
 */
const EXEMPT = new Set<string>([
  // Supabase-managed; not in our migration history in full.
  "schema_migrations",
]);

/**
 * Table -> column names, from the migration history.
 *
 * The parse itself lives in tests/helpers/migration-schema.ts, shared with the
 * device-schema guard (item 2.24). Two independent parsers of the same SQL is
 * the very shape of defect these guards exist to catch — they would agree until
 * one of them was fixed.
 */
function columnsFromSchema(sql: string): Map<string, Set<string>> {
  return new Map([...migrationTables(sql)].map(([table, cols]) => [table, new Set(cols.keys())]));
}

/**
 * Read a source file, or null if it cannot be read right now.
 *
 * This walks the LIVE working tree, so a file can be mid-write while the suite
 * runs — an editor saving, a formatter rewriting, a script generating. A bare
 * readFileSync then throws ENOENT and fails the whole table's check for reasons
 * that have nothing to do with schema drift. A security guard that goes red at
 * random teaches people to re-run it until it passes, which is worse than not
 * having it.
 *
 * Skipping an unreadable file is safe: the next run reads it, and CI works from
 * a clean checkout where nothing is being written concurrently.
 */
function readSource(file: string): string | null {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

function sourceFiles(dirs: string[]): string[] {
  const files: string[] = [];
  const walk = (dir: string) => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const e of entries) {
      if (e === "node_modules" || e === ".next" || e === "dist" || e.startsWith(".")) continue;
      const p = join(dir, e);
      let s: ReturnType<typeof statSync>;
      try {
        s = statSync(p);
      } catch {
        continue; // vanished between readdir and stat
      }
      if (s.isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(e) && !/\.test\.tsx?$/.test(e)) files.push(p);
    }
  };
  dirs.forEach((d) => walk(join(REPO, d)));
  return files;
}

// The extraction lives in tests/helpers/column-references.ts so it can be
// tested in its own right (column-references.test.ts) — items N13 and N14.
//
// It had two defects, and both made this guard see LESS than it claimed while
// staying green. The payload regex `\{([^}]*)\}` stopped at the first `}`, so
// every key after a nested object was invisible; and the scan window was 400
// chars while the comment beside it said ~600, which truncated 17 of the 383
// chains in this tree. Neither failed anything. That is the whole hazard with
// a guard: it does not break, it just quietly stops looking.

describe("schema column contract", () => {
  const schema = columnsFromSchema(migrationSql());
  const files = sourceFiles(["app", "lib", "components", join("mobile", "lib"), join("mobile", "app"), join("mobile", "components")]);

  // Every table the migration history defines, minus the exemptions. Derived
  // rather than listed, so a table added tomorrow is covered without anyone
  // remembering to add it here.
  const TABLES = [...schema.keys()].filter((t) => !EXEMPT.has(t)).sort();

  // Read every source file ONCE, not once per table.
  //
  // This was the cause of Q29 — a ~1-in-20 intermittent that escaped
  // identification three times. Each of the 33 per-table tests used to re-read
  // all ~200 source files from disk, so a single run did roughly 6,600 reads.
  // Normally that finishes inside vitest's 5s per-test default; under I/O
  // contention one table tips over and fails with "Test timed out in 5000ms".
  // WHICH table varies, which is exactly why the failure never had a stable
  // identity and looked like a mystery rather than a performance problem.
  //
  // Reading once is ~33x less I/O and removes the cause rather than raising the
  // timeout, which would only have widened the window.
  //
  // Files that are mid-write read as null (see readSource) and are skipped for
  // every table consistently, rather than for whichever table happened to be
  // running at that instant.
  const CONTENTS: [string, string][] = files
    .map((file) => [file, readSource(file)] as const)
    .filter((pair): pair is readonly [string, string] => pair[1] !== null)
    .map(([file, src]) => [file, src]);

  it("parses the canonical schema", () => {
    expect(schema.get("jobs")?.size ?? 0).toBeGreaterThan(10);
    expect(files.length).toBeGreaterThan(50);
  });

  it("covers every table in the migration history, not a hand-maintained list", () => {
    // The guard previously checked five named tables. Everything else could
    // drift freely — and a list someone has to remember to extend is a guard
    // with a shrinking blast radius.
    expect(TABLES.length).toBeGreaterThan(25);
    for (const t of ["jobs", "time_entries", "invoices", "backflow_tests", "job_photos"]) {
      expect(TABLES, `${t} must be covered`).toContain(t);
    }
  });

  for (const table of TABLES) {
    it(`every ${table} column referenced in source exists in the migration history`, () => {
      const known = schema.get(table);
      expect(known, `table ${table} missing from the migration history`).toBeTruthy();

      const offenders: string[] = [];
      for (const [file, src] of CONTENTS) {
        if (!src.includes(`"${table}"`) && !src.includes(`'${table}'`)) continue;
        for (const col of referencedColumns(src, table)) {
          // Embedded relations (`customers(name)`) and `*` are not columns.
          if (col === "count" || col === "id") continue;
          if (!known!.has(col)) offenders.push(`${file.replace(REPO, "").replace(/\\/g, "/")} → ${table}.${col}`);
        }
      }

      expect(
        offenders,
        `Columns referenced in source but absent from the migration history.\n` +
          `Either the migration is missing, or the reference is a typo:\n  ${offenders.join("\n  ")}`
      ).toEqual([]);
    });
  }
});
