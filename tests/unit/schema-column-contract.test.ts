import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

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
// `.insert({ col: … })` on a chain naming a known table. It will not catch every
// possible reference (dynamic column names, spread payloads, RPC arguments), so
// it is a high-value net, not a proof. Extend TABLES as more tables earn the
// same protection.

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

/** Parse `create table <name> ( … );` blocks into a column-name set. */
function columnsFromSchema(sql: string): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const tableRe = /create table (?:if not exists )?(\w+)\s*\(([\s\S]*?)\n\);/gi;
  for (const [, table, body] of sql.matchAll(tableRe)) {
    const cols = new Set<string>();
    for (const line of body.split("\n")) {
      const t = line.trim();
      // Skip constraints and table-level clauses; a column line starts with its name.
      if (!t || /^(primary key|foreign key|unique|check|constraint|references)\b/i.test(t)) continue;
      const m = t.match(/^"?(\w+)"?\s+/);
      if (m) cols.add(m[1]);
    }
    out.set(table, cols);
  }
  // Later migrations may add columns; fold in every `alter table … add column`.
  // `[^;]*?` matters: without it the gap spans whole files and pairs an early
  // `alter table` with a much later `add column`, silently losing real columns.
  const alterRe = /alter table (?:only )?(\w+)[^;]*?add column (?:if not exists )?"?(\w+)"?/gi;
  for (const [, table, col] of sql.matchAll(alterRe)) {
    if (!out.has(table)) out.set(table, new Set());
    out.get(table)!.add(col);
  }
  return out;
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
      const s = statSync(p);
      if (s.isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(e) && !/\.test\.tsx?$/.test(e)) files.push(p);
    }
  };
  dirs.forEach((d) => walk(join(REPO, d)));
  return files;
}

/** Column references tied to a table, e.g. `.from("jobs")…update({ ready_to_invoice: … })`. */
function referencedColumns(src: string, table: string): Set<string> {
  const found = new Set<string>();
  // Each `.from("<table>")` starts a chain; inspect the following ~600 chars.
  const fromRe = new RegExp(`\\.from\\(\\s*["'\`]${table}["'\`]\\s*\\)`, "g");
  for (const m of src.matchAll(fromRe)) {
    // Stop at the next `.from(` so a neighbouring chain's columns are not
    // attributed to this table (a real source of false positives).
    const rest = src.slice(m.index! + m[0].length);
    const nextFrom = rest.search(/\.from\(/);
    const chunk = rest.slice(0, nextFrom === -1 ? 400 : Math.min(nextFrom, 400));
    for (const [, col] of chunk.matchAll(/\.(?:eq|neq|gt|gte|lt|lte|is|in|order)\(\s*["'`](\w+)["'`]/g)) {
      found.add(col);
    }
    // `.update({ a: 1, b: 2 })` / `.insert({ … })` object keys
    for (const om of chunk.matchAll(/\.(?:update|insert|upsert)\(\s*\{([^}]*)\}/g)) {
      const body = om[1];
      for (const [, key] of body.matchAll(/(?:^|,)\s*(\w+)\s*:/g)) found.add(key);
      // SHORTHAND properties — `{ hours, entry_type: "travel" }`. This is not a
      // hypothetical: the geofence auto-clock wrote `hours` exactly this way, and
      // the colon-only pattern above walked straight past it for months. A guard
      // that misses the idiomatic spelling of a write is barely a guard.
      for (const [, key] of body.matchAll(/(?:^|,)\s*(\w+)\s*(?=[,}]|$)/g)) found.add(key);
    }
  }
  return found;
}

describe("schema column contract", () => {
  const schema = columnsFromSchema(migrationSql());
  const files = sourceFiles(["app", "lib", "components", join("mobile", "lib"), join("mobile", "app"), join("mobile", "components")]);

  // Every table the migration history defines, minus the exemptions. Derived
  // rather than listed, so a table added tomorrow is covered without anyone
  // remembering to add it here.
  const TABLES = [...schema.keys()].filter((t) => !EXEMPT.has(t)).sort();

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
      for (const file of files) {
        const src = readFileSync(file, "utf8");
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
