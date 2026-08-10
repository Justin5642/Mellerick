import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { migrationTables } from "../helpers/migration-schema";

// ============================================================================
// Item 3.3 — the half that makes a generated type file worth having.
//
// `lib/database.types.ts` on its own is a 2000-line artifact that looks
// authoritative and has no way of noticing it has gone stale. The value of
// generated types is that a column name typed wrong stops COMPILING — and that
// only holds while the file matches the database. A stale copy is worse than no
// copy: it makes a column that no longer exists look real to the compiler and
// to everyone reading it.
//
// So the file is checked against the migration history on every run, the same
// way the device schema is (item 2.24). A migration that adds a column and no
// regeneration is a failing build with a one-line fix:
//
//   npm run gen:types
//
// SCOPE. Presence, not shape: every table and column the migrations create must
// appear in the Row type. Comparing the TypeScript types themselves would mean
// reimplementing Postgres-to-TypeScript mapping here, and a guard that
// reimplements the thing it checks is testing its own copy.
// ============================================================================

const REPO = join(__dirname, "..", "..");
const TYPES = join(REPO, "lib", "database.types.ts");

function migrationSql(): string {
  const dir = join(REPO, "supabase", "migrations");
  return readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => readFileSync(join(dir, f), "utf8"))
    .join("\n");
}

/**
 * table -> columns, from the `Tables:` section's `Row` types.
 *
 * Line-oriented on purpose. The generated file is machine-written with fixed
 * indentation, so indentation is a reliable structure signal here in a way it
 * would not be in hand-written source — and it stops the scan at `Views:`
 * without needing to understand TypeScript.
 */
function typedTables(src: string): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const lines = src.split(/\r?\n/);

  let inTables = false;
  let table: string | null = null;
  let inRow = false;

  for (const line of lines) {
    if (/^ {4}Tables: \{$/.test(line)) {
      inTables = true;
      continue;
    }
    if (!inTables) continue;
    if (/^ {4}(Views|Functions|Enums|CompositeTypes): /.test(line)) break;

    const tableStart = line.match(/^ {6}(\w+): \{$/);
    if (tableStart) {
      table = tableStart[1];
      out.set(table, new Set());
      inRow = false;
      continue;
    }
    if (!table) continue;

    if (/^ {8}Row: \{$/.test(line)) {
      inRow = true;
      continue;
    }
    if (inRow && /^ {8}\}$/.test(line)) {
      inRow = false;
      continue;
    }
    if (inRow) {
      const col = line.match(/^ {10}(\w+)\??: /);
      if (col) out.get(table)!.add(col[1]);
    }
  }
  return out;
}

const migrations = migrationTables(migrationSql());
const typed = typedTables(readFileSync(TYPES, "utf8"));

describe("lib/database.types.ts is generated and current (3.3)", () => {
  it("is marked as generated, so nobody hand-edits two thousand lines", () => {
    const head = readFileSync(TYPES, "utf8").slice(0, 400);
    expect(head).toContain("GENERATED FILE");
    expect(head).toContain("npm run gen:types");
  });

  it("parsed both sides", () => {
    // The vacuity guard. Every assertion below is trivially true against empty
    // maps, and a parser that silently stops matching is the failure mode these
    // guards keep producing.
    expect({
      migrationTables: migrations.size >= 30,
      typedTables: typed.size >= 30,
      jobsColumns: (typed.get("jobs")?.size ?? 0) > 10,
    }).toEqual({ migrationTables: true, typedTables: true, jobsColumns: true });
  });

  it("has a type for every table the migrations create", () => {
    const missing = [...migrations.keys()].filter((t) => !typed.has(t)).sort();
    expect(missing).toEqual([]);
  });

  it("has every column the migrations create", () => {
    // The stale-file failure, and the one that matters: a migration adds a
    // column, nobody re-runs the generator, and the compiler goes on believing
    // the old shape. Fix by running `npm run gen:types`, not by editing here.
    const missing: string[] = [];
    for (const [table, cols] of migrations) {
      const row = typed.get(table);
      if (!row) continue; // reported above
      for (const col of cols.keys()) if (!row.has(col)) missing.push(`${table}.${col}`);
    }
    expect(missing.sort()).toEqual([]);
  });

  it("does not describe a table the migrations never create", () => {
    // The other direction: a table dropped from the migrations but still typed
    // here reads as real to everyone using the types.
    const extra = [...typed.keys()].filter((t) => !migrations.has(t)).sort();
    expect(extra).toEqual([]);
  });
});
