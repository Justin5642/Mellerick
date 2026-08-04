#!/usr/bin/env node
// Compare the LIVE database schema against what the migration history defines.
//
// WHY THIS EXISTS SEPARATELY FROM THE TEST GUARD
// tests/unit/schema-column-contract.test.ts checks that every column the SOURCE
// references exists in the migration history. That catches the case that breaks
// the app — code naming a column the database lacks.
//
// It cannot catch the reverse, by construction: a column that exists in
// production and in no migration, which no source file happens to reference yet.
// Nothing is broken today, so nothing complains — until someone rebuilds the
// database from migrations and it comes up subtly different, or a later
// migration collides with a column it did not know was there.
//
// This project has hit the drift class three times (jobs.ready_to_invoice,
// jobs.admin_status/admin_notes, time_entries.hours). Two were found only
// because the app was visibly broken. This is the check that finds them before
// that.
//
// USAGE
//   node scripts/check-schema-drift.mjs
//
// Requires the Supabase CLI linked to the project (supabase/.temp/project-ref)
// and run from the repo root. Read-only: it generates types and reads files.
// Exits 1 when drift is found, so it can gate a release.

import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const MIGRATIONS = join(process.cwd(), "supabase", "migrations");

function liveTypes() {
  try {
    return execFileSync("npx", ["supabase", "gen", "types", "typescript", "--linked"], {
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
      shell: process.platform === "win32",
    });
  } catch (e) {
    console.error("Could not read the live schema. Is the CLI linked, and are you in the repo root?");
    console.error(String(e.message ?? e));
    process.exit(2);
  }
}

function migrationSql() {
  return readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => readFileSync(join(MIGRATIONS, f), "utf8"))
    .join("\n");
}

/** Columns the migration history defines for one table. */
function migrationColumns(sql, table) {
  const cols = new Set();
  const create = new RegExp(`create table (?:if not exists )?${table}\\s*\\(([\\s\\S]*?)\\n\\);`, "i");
  const m = sql.match(create);
  if (m) {
    for (const line of m[1].split("\n")) {
      const t = line.trim();
      if (!t || /^(primary key|foreign key|unique|check|constraint|references)\b/i.test(t)) continue;
      const c = t.match(/^"?(\w+)"?\s+/);
      if (c) cols.add(c[1]);
    }
  }
  const alter = new RegExp(
    `alter table (?:only )?${table}[^;]*?add column (?:if not exists )?"?(\\w+)"?`,
    "gi"
  );
  for (const [, col] of sql.matchAll(alter)) cols.add(col);
  return cols;
}

const types = liveTypes();
const sql = migrationSql();

// The generated file lists views alongside tables. A view has no `create table`,
// so it would report as wholly missing — the rate-stripped *_public views from
// migrations 0035/0038 are exactly that. Skip anything the migrations create as
// a view rather than a table.
const isView = (name) => new RegExp(`create (?:or replace )?view ${name}\\b`, "i").test(sql);

const drift = [];
for (const m of types.matchAll(/^ {6}(\w+): \{\n {8}Row: \{([\s\S]*?)\n {8}\}/gm)) {
  const table = m[1];
  if (isView(table)) continue;
  const live = new Set([...m[2].matchAll(/^\s+(\w+)\??:/gm)].map((x) => x[1]));
  const known = migrationColumns(sql, table);
  if (known.size === 0) {
    drift.push(`${table}: table exists in production but no migration creates it`);
    continue;
  }
  const missing = [...live].filter((c) => !known.has(c)).sort();
  if (missing.length) drift.push(`${table}: ${missing.join(", ")}`);
}

if (drift.length === 0) {
  console.log("No drift: every production column is accounted for in the migration history.");
  process.exit(0);
}

console.error("SCHEMA DRIFT — present in production, absent from the migration history:\n");
for (const d of drift) console.error(`  ${d}`);
console.error(
  "\nCapture each one in a new migration with `add column if not exists`, which is a\n" +
    "no-op against production. The goal is a history that can rebuild production."
);
process.exit(1);
