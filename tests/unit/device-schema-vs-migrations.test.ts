import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";

import { migrationTables, toInformationSchemaType } from "../helpers/migration-schema";

// ============================================================================
// Item 2.24 — the axis nothing was checking.
//
// THE SHIPPED BUG. mobile/lib/powersync/schema.ts is GENERATED from two
// sources: sync-streams.yaml (which columns are synced) and LIVE Postgres
// (their types). `jobs` is synced with `SELECT jobs.*` by the office stream,
// so every column Postgres has for it belongs in that file — and the file is
// only correct if someone re-ran the generator after the migration that added
// one. Nobody did, for jobs.ready_to_invoice (migration 0040). The device table
// is a SQLite view built from the declared columns, so the column was simply
// absent, and a local query naming it died with "no such column". source.ts
// caught that and fell back to Supabase, silently in production. Online the
// screen worked; OFFLINE it was permanently broken, which is the one case the
// mirror exists for.
//
// WHY THE EXISTING GUARDS DO NOT CATCH IT. sqlLint.test.ts checks the local SQL
// against this same generated schema, so when both go stale together it stays
// green — the query and the schema agree with each other and disagree with the
// database. schema.test.ts checks the generated schema against
// sync-streams.yaml, which is the same pair of files. Neither compares against
// the migration history, so nothing noticed that a THIRD representation had
// moved.
//
// WHY MIGRATIONS AND NOT LIVE POSTGRES. Checking a generated-from-live artifact
// against live proves only that a generator ran against something. The
// migration history is the representation this repo controls and CI rebuilds
// from, and it is the thing that changes when a developer adds a column. That
// makes it the one worth comparing to. `npm run check:drift` covers the other
// direction — migrations against production — so the two together close the
// triangle rather than either one closing a loop with itself.
//
// It also means this runs with no database, in every environment, which the
// guard it replaces (nothing) very much did not.
// ============================================================================

const REPO = join(__dirname, "..", "..");
const require_ = createRequire(import.meta.url);
// CommonJS on purpose — the generator's pure logic is a .js module precisely so
// both the ESM script and test suites can load it. Reusing sqliteType here
// rather than restating the mapping is the point: a guard that reimplements the
// thing it checks tests its own copy.
const { parseStreams, sqliteType } = require_(join(REPO, "mobile/scripts/powersync-schema-lib.js"));

function migrationSql(): string {
  const dir = join(REPO, "supabase", "migrations");
  return readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => readFileSync(join(dir, f), "utf8"))
    .join("\n");
}

/**
 * The generated file's tables, read as TEXT rather than imported.
 *
 * Importing it would drag in @powersync/common, which this node-environment
 * suite has no reason to load, and would mean the guard passes or fails on
 * whether a React Native package resolves. The text is the artifact under
 * review.
 */
function deviceSchema(src: string): Map<string, Map<string, string>> {
  const out = new Map<string, Map<string, string>>();
  for (const m of src.matchAll(/const (\w+) = new Table\(\{([\s\S]*?)\n\}\);/g)) {
    const cols = new Map<string, string>();
    for (const c of m[2].matchAll(/^\s*(\w+):\s*column\.(\w+),/gm)) cols.set(c[1], c[2]);
    out.set(m[1], cols);
  }
  return out;
}

const migrations = migrationTables(migrationSql());
const streams: Map<string, Set<string> | "ALL"> = parseStreams(
  readFileSync(join(REPO, "mobile", "powersync", "sync-streams.yaml"), "utf8")
);
const device = deviceSchema(readFileSync(join(REPO, "mobile", "lib", "powersync", "schema.ts"), "utf8"));

// PowerSync makes `id` implicit, so it never appears in a Table's columns.
const IMPLICIT = new Set(["id"]);

describe("the generated device schema still matches the migration history (2.24)", () => {
  it("parsed all three representations", () => {
    // Every assertion below is trivially true against an empty map. This is
    // the vacuity guard: if a parser stops matching, THIS fails, loudly, rather
    // than the suite going quietly green.
    expect({
      migrationTables: migrations.size >= 30,
      streamTables: streams.size >= 20,
      deviceTables: device.size >= 20,
      jobsColumnsParsed: (migrations.get("jobs")?.size ?? 0) > 10,
    }).toEqual({ migrationTables: true, streamTables: true, deviceTables: true, jobsColumnsParsed: true });
  });

  it("declares no table the migration history does not create", () => {
    const orphans = [...device.keys()].filter((t) => !migrations.has(t)).sort();
    expect(orphans).toEqual([]);
  });

  it("declares no column the migration history does not create", () => {
    // The device believing in a column production lacks. Every read of it
    // returns NULL locally and fails against Supabase on the fallback path.
    const orphans: string[] = [];
    for (const [table, cols] of device) {
      const mig = migrations.get(table);
      if (!mig) continue;
      for (const col of cols.keys()) if (!mig.has(col)) orphans.push(`${table}.${col}`);
    }
    expect(orphans.sort()).toEqual([]);
  });

  it("is missing no column its streams promise to sync", () => {
    // THE ready_to_invoice SHAPE, and the reason this file exists. A migration
    // adds a column, `SELECT jobs.*` starts syncing it, and the generator is
    // never re-run — so the device view has no such column and the offline
    // screen is broken while the online one is fine.
    //
    // To fix a failure here, do not edit the schema by hand. Run:
    //   node mobile/scripts/generate-powersync-schema.mjs
    const missing: string[] = [];
    for (const [table, want] of streams) {
      const mig = migrations.get(table);
      const dev = device.get(table);
      if (!mig || !dev) continue;
      const expected = want === "ALL" ? [...mig.keys()] : [...want];
      for (const col of expected) {
        if (IMPLICIT.has(col)) continue;
        if (want !== "ALL" && !mig.has(col)) continue; // reported by the next test
        if (!dev.has(col)) missing.push(`${table}.${col}`);
      }
    }
    expect(missing.sort()).toEqual([]);
  });

  it("syncs no column the migration history does not create", () => {
    // The streams file naming a column that exists in neither migrations nor
    // the database. PowerSync would reject the stream at deploy time; better to
    // find out here than from a sync that stops working on every device.
    const unknown: string[] = [];
    for (const [table, want] of streams) {
      const mig = migrations.get(table);
      if (!mig || want === "ALL") continue;
      for (const col of want) if (!IMPLICIT.has(col) && !mig.has(col)) unknown.push(`${table}.${col}`);
    }
    expect(unknown.sort()).toEqual([]);
  });

  it("declares the SQLite type the column's Postgres type maps to", () => {
    // A type mismatch is quieter than a missing column and worse to debug: the
    // column exists, the query runs, and the value comes back as the wrong JS
    // type. A `numeric` declared `text` turns money into a string that
    // arithmetic silently concatenates.
    const wrong: string[] = [];
    for (const [table, cols] of device) {
      const mig = migrations.get(table);
      if (!mig) continue;
      for (const [col, declared] of cols) {
        const pg = mig.get(col);
        if (!pg) continue; // reported above
        const expected = sqliteType(toInformationSchemaType(pg));
        if (expected !== declared) {
          wrong.push(`${table}.${col}: declared ${declared}, migration says ${pg} -> ${expected}`);
        }
      }
    }
    expect(wrong.sort()).toEqual([]);
  });
});
