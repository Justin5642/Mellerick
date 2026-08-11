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
// This project has hit the drift class five times: jobs.ready_to_invoice
// (0040), jobs.admin_status/admin_notes (0041), time_entries.hours and
// job_variations.attachment_file_name (0043), three storage buckets that existed
// in production and in no migration (0049), and the generated device schema that
// went stale behind a wildcard sync stream. Most were found only because
// something was visibly broken.
//
// AND THIS CHECK EXISTED THROUGHOUT. It never ran, because it required a
// logged-in Supabase CLI that nobody had — so a working guard sat in the repo
// while the thing it guards against happened five times. That is the real
// lesson, and it is why the default path below needs nothing but the
// service-role key that is already in .env.
//
// USAGE
//   npm run check:drift                 # PostgREST + service-role key
//   node scripts/check-schema-drift.mjs --linked   # Supabase CLI instead
//
// Run from the repo root. Read-only: two GETs and some file reads, no writes.
// Exits 1 when drift is found, so it can gate a release.
//
// WHAT IT COVERS: table columns, and storage buckets (including a public-bucket
// check, since a public bucket makes every storage policy on it decorative).
// WHAT IT DOES NOT: views, functions, triggers, RLS policies, the powersync
// publication, and anything in a non-public schema.
//
// IT CANNOT RUN IN CI. .github/workflows/ci.yml holds no secrets at all, by
// design, so nothing there can reach production. The half that needs no
// credentials — "did the repo create schema somewhere the migration history
// will not record it?" — lives in tests/unit/schema-outside-migrations.test.ts
// and does run on every push. This one is a human gate: run it before a release,
// and after anyone touches the database by hand.

import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const MIGRATIONS = join(process.cwd(), "supabase", "migrations");

// WHY THERE ARE TWO SOURCES.
//
// This check was written to catch production columns missing from the migration
// history, and it has never once run — `npm run check:drift` needs a LOGGED-IN
// Supabase CLI, and nobody has one to hand. Meanwhile the drift it exists to
// find has landed five times: jobs.ready_to_invoice (0040), jobs.admin_status
// and admin_notes (0041), time_entries.hours and
// job_variations.attachment_file_name (0043), three storage buckets created only
// by scripts, and jobs.ready_to_invoice again on the device side.
//
// A guard that cannot be run is not a guard. The default path now uses
// PostgREST's OpenAPI description and the service-role key already in .env —
// the same route every other script in this repo takes. `--linked` keeps the
// original CLI path for anyone who has it.
function readEnvFile() {
  for (const file of [".env.local", ".env"]) {
    try {
      for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
        const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
        if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
      }
    } catch {}
  }
}

/**
 * The live schema came back with zero tables. Under BOTH sources this means the
 * read format changed under us — a PostgREST spec with no definitions, or a
 * `gen types` output the regex no longer matches — not that production is empty.
 * Proceeding would make every drift assertion trivially true and print "No
 * drift": the exact vacuous pass this whole script exists to stop being bitten by.
 */
function refuseEmptySchema(out, source) {
  if (out.size === 0) {
    console.error(`The live schema came back with zero tables via ${source}. Refusing to report 'no drift'.`);
    console.error("The read succeeded but produced nothing to compare — treat this as a broken check, not a pass.");
    process.exit(2);
  }
}

/** Live columns per table, as Map<table, Set<column>>. */
async function liveColumns() {
  // Load .env for BOTH sources, not just PostgREST. The storage-bucket half of
  // this check (further down) reads NEXT_PUBLIC_SUPABASE_URL / SERVICE_ROLE_KEY
  // straight from process.env; when this was only called on the PostgREST path,
  // `node check-schema-drift.mjs --linked` (the documented invocation) skipped
  // the bucket check entirely and still printed that every bucket was accounted
  // for — a second vacuous pass hidden behind the first.
  readEnvFile();

  if (process.argv.includes("--linked")) {
    let types;
    try {
      types = execFileSync("npx", ["supabase", "gen", "types", "typescript", "--linked"], {
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
    const out = new Map();
    for (const m of types.matchAll(/^ {6}(\w+): \{\n {8}Row: \{([\s\S]*?)\n {8}\}/gm)) {
      out.set(m[1], new Set([...m[2].matchAll(/^\s+(\w+)\??:/gm)].map((x) => x[1])));
    }
    // Same guard the PostgREST branch has always had — the `--linked` branch
    // never did, so a `gen types` format change would report clean here.
    refuseEmptySchema(out, "the Supabase CLI (gen types)");
    return out;
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error(
      "Need NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env (or pass --linked\n" +
        "to use a logged-in Supabase CLI instead)."
    );
    process.exit(2);
  }
  const res = await fetch(`${url}/rest/v1/`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
  });
  if (!res.ok) {
    console.error(`Could not read the live schema over PostgREST: ${res.status} ${await res.text()}`);
    process.exit(2);
  }
  const spec = await res.json();
  const defs = spec.definitions ?? spec.components?.schemas ?? {};
  const out = new Map();
  for (const [table, def] of Object.entries(defs)) {
    if (def?.properties) out.set(table, new Set(Object.keys(def.properties)));
  }
  refuseEmptySchema(out, "PostgREST");
  return out;
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

const live = await liveColumns();
const sql = migrationSql();

// The generated file lists views alongside tables. A view has no `create table`,
// so it would report as wholly missing — the rate-stripped *_public views from
// migrations 0035/0038 are exactly that. Skip anything the migrations create as
// a view rather than a table.
const isView = (name) => new RegExp(`create (?:or replace )?view ${name}\\b`, "i").test(sql);

const drift = [];
for (const [table, liveCols] of live) {
  if (isView(table)) continue;
  const known = migrationColumns(sql, table);
  if (known.size === 0) {
    drift.push(`${table}: table exists in production but no migration creates it`);
    continue;
  }
  const missing = [...liveCols].filter((c) => !known.has(c)).sort();
  if (missing.length) drift.push(`${table}: ${missing.join(", ")}`);
}

// ---------------------------------------------------------------------------
// STORAGE BUCKETS — the drift class a column check cannot see.
//
// Buckets live in storage.buckets, not in any table this script compares, so
// they were invisible to it. Three of the five existed in production and in NO
// migration (job-audio and backflow-certificates were created by scripts;
// job-documents, with 3909 objects, by nothing recorded in this repo at all).
// A database rebuilt from migrations therefore carried storage POLICIES for
// buckets it did not have — which is why 0047's and 0048's storage tests could
// never fail: a select against a bucket that does not exist returns zero rows
// perfectly happily. It took an INSERT, in CI, to surface it.
// ---------------------------------------------------------------------------
const bucketDrift = [];
let bucketsChecked = false;
{
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (url && key) {
    const res = await fetch(`${url}/storage/v1/bucket`, {
      headers: { apikey: key, Authorization: `Bearer ${key}` },
    });
    if (res.ok) {
      bucketsChecked = true;
      const liveBuckets = await res.json();
      const declared = new Set(
        [...sql.matchAll(/insert into storage\.buckets[\s\S]*?values\s*([\s\S]*?);/gi)]
          .flatMap((m) => [...m[1].matchAll(/\(\s*'([^']+)'/g)].map((x) => x[1]))
      );
      for (const b of liveBuckets) {
        if (!declared.has(b.id)) {
          bucketDrift.push(`${b.id}: bucket exists in production and in no migration`);
        }
        // A public bucket serves objects to anyone with the URL, RLS or not, so
        // every storage policy on it is decorative. Worth reporting loudly even
        // when the bucket IS declared.
        if (b.public) bucketDrift.push(`${b.id}: bucket is PUBLIC — storage RLS on it is decorative`);
      }
    } else {
      bucketDrift.push(`(could not read buckets: ${res.status} — bucket drift NOT checked)`);
    }
  } else {
    // Reachable when .env has no service-role key. Before readEnvFile() ran for
    // both sources this was the SILENT state of every `--linked` run: no creds,
    // no bucket read, and the summary below still said "every bucket accounted
    // for". Say it was skipped instead.
    bucketDrift.push(
      "(no NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in env — bucket drift NOT checked)"
    );
  }
}

const problems = [...drift.map((d) => ["column", d]), ...bucketDrift.map((d) => ["bucket", d])];

if (problems.length === 0) {
  // Only claim the buckets are clean if they were actually read. bucketsChecked
  // is false only when the block above pushed a "NOT checked" note, so this
  // branch means every bucket genuinely reconciled — but guard it anyway, so a
  // future edit cannot make "no problems" silently mean "did not look".
  if (!bucketsChecked) {
    console.error("Columns show no drift, but the storage buckets were NOT checked (see note below).");
    for (const [, d] of bucketDrift) console.error(`  ${d}`);
    process.exit(2);
  }
  console.log(
    `No drift: ${live.size} live relations and every storage bucket are accounted for in the\n` +
      `migration history. (Checked columns AND buckets — see the header for what is still\n` +
      `out of scope: views, functions, triggers, policies and the publication.)`
  );
  process.exit(0);
}

console.error("SCHEMA DRIFT — present in production, absent from the migration history:\n");
for (const [kind, d] of problems) console.error(`  [${kind}] ${d}`);
console.error(
  "\nCapture each one in a new migration. Columns: `add column if not exists`.\n" +
    "Buckets: `insert into storage.buckets (id, name, public) values (...) on conflict (id)\n" +
    "do nothing`. Both are no-ops against production. The goal is a history that can rebuild\n" +
    "production — because until it can, every test that runs against a rebuilt database is\n" +
    "testing a different database from the one your users are on."
);
process.exit(1);
