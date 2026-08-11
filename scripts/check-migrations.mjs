#!/usr/bin/env node
// Does every migration header tell the truth about whether it is applied?
//
// WHY THIS EXISTS
// A header saying "DRAFT — NOT APPLIED" after the migration HAS been applied is
// not cosmetic. `supabase db push` applies whatever the ledger lacks; it does
// not read comments. So a stale header protects nothing while misleading
// everyone: 0035 and 0038 claimed the dollar-leak boundary was not in force for
// about a week after it was, 0036 hid the real push blocker behind a false one,
// and 0037's own header records that its stale version misled three code
// comments.
//
// WHY IT EXISTS AS A SEPARATE THING FROM THE TEST
// tests/unit/migration-header-truth.test.ts pins the claim-DETECTION: that a
// header says one thing, and that `claimsNotApplied` still recognises the
// phrasing in front of it. It cannot ask production what is applied — CI holds
// no credentials for that, deliberately. This script is the half that asks.
//
// It was cited as a live guard — by that test, by HANDOVER-HARDENING.md, and by
// the header of every one of 0049..0053 — before it existed. Five migrations
// therefore carried a "the build fails if this line is still here once it IS
// applied" promise that nothing kept. That is the same defect this repo keeps
// finding, in the guard layer itself.
//
// USAGE
//   npm run check:migrations
//
// Needs the Supabase CLI linked to the project (supabase/.temp/project-ref).
// Read-only: one select against supabase_migrations.schema_migrations.
//
// EXIT CODES — the reason there are three
//   0  every header agrees with the ledger
//   1  a header contradicts the ledger, or production holds a migration this
//      repo does not have
//   2  the ledger could not be read, so NOTHING was checked
//
// 2 is not 0. A check that cannot reach the database must not look like a check
// that passed — `npm run check:drift` sat unrunnable in this repo while the
// drift it guards against landed five times, and the lesson there was that a
// guard nobody can run is a guard nobody has. The next best thing is a guard
// that says so at the top of its voice.
//
// WHY THERE IS NO --local MODE. A local stack answers a different question:
// scripts/ci-apply-migrations.sh deliberately applies the drafts after
// production's migrations so their test suites can run, so every draft would
// report here as a stale header. The claim these headers make is about
// PRODUCTION, and only the linked project can settle it.

import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { claimsNotApplied, claimsApplied } from "./migration-header-claim.mjs";
import { parseCliRows, singleJsonColumn } from "./supabase-cli-json.mjs";

const MIGRATIONS = join(process.cwd(), "supabase", "migrations");

// One line on purpose: on Windows the CLI is invoked through a shell, and
// although the statement travels by file rather than by argument, keeping it to
// a single line removes any question of where a truncation could come from.
const SQL =
  "select coalesce(json_agg(version order by version), '[]'::json)::text as versions from supabase_migrations.schema_migrations";

/** The version `supabase db push` records for a file, or null if it records none. */
export function versionOf(file) {
  const m = /^(\d+)_/.exec(file);
  return m ? m[1] : null;
}

/**
 * Read the version list out of the Supabase CLI's output.
 *
 * The CLI emits a different shape depending on how the process is attached —
 * an agent envelope when piped, a bare array in a terminal, a box-drawing table
 * with no format flag at all. parseCliRows owns that; the measured matrix is in
 * scripts/supabase-cli-json.mjs.
 *
 * Throws rather than returning [] on anything unexpected. An empty list would
 * present as "production has applied nothing", against which no header can be
 * caught lying: every draft would look honest and the script would exit 0.
 */
export function parseLedger(out) {
  const rows = parseCliRows(out);
  if (rows.length === 0) {
    throw new Error("the migration ledger query returned no rows at all");
  }

  const versions = singleJsonColumn(rows);
  if (!Array.isArray(versions)) {
    throw new Error(`expected an array of versions, got: ${JSON.stringify(versions)}`);
  }
  if (versions.length === 0) {
    // 0000_baseline is in production by definition — this database exists. An
    // empty ledger means the query reached the wrong place, not that nothing is
    // applied, and reporting "all headers honest" from it would be a lie.
    throw new Error("the migration ledger came back empty. Refusing to report every header as honest.");
  }
  return versions.map(String);
}

/**
 * The comparison, as a pure function of the headers and the ledger — exported
 * and unit-tested in tests/unit/check-migrations.test.ts.
 *
 * Separated from the I/O deliberately. This script cannot run in CI, so its
 * reporting paths would otherwise only ever execute on the day something is
 * actually wrong.
 *
 * `files` is [{ file, claimsNotApplied, claimsApplied }]; `applied` is the
 * version list from the ledger. Returns { problems, pending }.
 */
export function compare({ files, applied }) {
  const ledger = new Set(applied.map((v) => String(v).trim()));
  const problems = [];
  const pending = [];
  const seen = new Set();

  for (const f of files) {
    const version = versionOf(f.file);
    if (version === null) {
      problems.push({
        kind: "unversioned-file",
        file: f.file,
        version: null,
        message: `${f.file}: no leading version, so the ledger can never record it and this check can never see it`,
      });
      continue;
    }
    seen.add(version);
    const isApplied = ledger.has(version);

    if (f.claimsNotApplied && isApplied) {
      problems.push({
        kind: "stale-draft-header",
        file: f.file,
        version,
        message: `${f.file}: the header says it is NOT applied, but the ledger has ${version}. Correct the header — a stale one told readers the dollar-leak boundary was open for a week after it was closed.`,
      });
      continue;
    }

    if (f.claimsApplied && !isApplied) {
      problems.push({
        kind: "unapplied-claim",
        file: f.file,
        version,
        message: `${f.file}: the header says it is applied and verified in production, and the ledger has never heard of ${version}.`,
      });
      continue;
    }

    // A file that states no status claims nothing, and cannot be caught lying.
    // Listed so an unapplied migration is still visible, not treated as a fault.
    if (!isApplied) pending.push({ file: f.file, version, draft: f.claimsNotApplied });
  }

  for (const version of ledger) {
    if (seen.has(version)) continue;
    problems.push({
      kind: "applied-without-file",
      file: null,
      version,
      message: `${version}: applied in production, and no migration in this repo carries that version. A database rebuilt from this history will not match production.`,
    });
  }

  return { problems, pending };
}

function readLedger() {
  // The statement goes through a FILE, not the command line: on Windows the CLI
  // needs `shell: true` (Node refuses to spawn npx.cmd without one), and cmd.exe
  // then re-parses embedded quotes into something the CLI cannot run. That
  // returns an empty result, which this script would have to interpret — and
  // there is no safe interpretation of "the ledger might be empty".
  //
  // execFileSync, not exec: every argument below is a fixed literal, and the
  // one piece of variable text (the statement) never touches a command line.
  const file = join(tmpdir(), `mellerick-check-migrations-${process.pid}.sql`);
  writeFileSync(file, SQL, "utf8");
  try {
    // `--output-format json` is what stops the CLI printing a box-drawing
    // TABLE when a person runs this in a terminal. It does NOT make the output
    // shape constant — the CLI still switches between an agent envelope and a
    // bare array depending on how the process is attached — so the parser
    // handles both. See scripts/supabase-cli-json.mjs for the measured matrix.
    const argv = ["supabase", "db", "query", "--linked", "--output-format", "json", "--file", file];
    return execFileSync("npx", argv, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      shell: process.platform === "win32",
    });
  } finally {
    try {
      unlinkSync(file);
    } catch {
      /* best effort — a stray temp file is not worth failing the check over */
    }
  }
}

function readMigrations() {
  return readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((file) => {
      const src = readFileSync(join(MIGRATIONS, file), "utf8");
      return { file, claimsNotApplied: claimsNotApplied(src), claimsApplied: claimsApplied(src) };
    });
}

function main() {
  // Exit 2, not an uncaught throw. Node exits 1 on an unhandled error, and 1
  // already means "a header contradicts the ledger" — a wrong directory would
  // otherwise report as a finding.
  let files;
  try {
    files = readMigrations();
  } catch (e) {
    console.error(`CANNOT CHECK: could not read ${MIGRATIONS} — ${String(e.message || e)}`);
    console.error("Run this from the repo root.");
    process.exit(2);
  }
  if (files.length === 0) {
    console.error(`CANNOT CHECK: no .sql files under ${MIGRATIONS}. Run this from the repo root.`);
    process.exit(2);
  }

  let applied;
  try {
    applied = parseLedger(readLedger());
  } catch (e) {
    console.error("CANNOT CHECK — the migration ledger was NOT read, so nothing was verified.");
    console.error("");
    console.error("  This is not a pass. No header has been compared against anything.");
    console.error("");
    console.error("  Needs a logged-in Supabase CLI linked to the project:");
    console.error("      npx supabase login && npx supabase link --project-ref <ref>");
    console.error("  (supabase/.temp/project-ref records which project that is.)");
    console.error("");
    console.error(String(e.message || e).split("\n").slice(0, 6).join("\n"));
    process.exit(2);
  }

  const { problems, pending } = compare({ files, applied });

  for (const p of pending) {
    console.log(`  pending${p.draft ? " (DRAFT)" : "        "}  ${p.file}`);
  }
  if (pending.length) console.log("");

  if (problems.length === 0) {
    console.log(
      `Headers agree with the ledger: ${applied.length} migration(s) applied in production, ` +
        `${pending.length} not yet applied (${pending.filter((p) => p.draft).length} marked DRAFT).`
    );
    process.exit(0);
  }

  console.error("MIGRATION HEADERS DISAGREE WITH THE LEDGER:\n");
  for (const p of problems) console.error(`  [${p.kind}] ${p.message}`);
  console.error(
    "\nThe ledger is the only authority on what is applied — `supabase db push` reads it and\n" +
      "not these comments. Fix the header, or capture the out-of-band migration, so the next\n" +
      "person to read this directory is not misled about what production actually has."
  );
  process.exit(1);
}

// Only run when invoked as a script. `compare`, `parseLedger` and `versionOf`
// are imported by tests/unit/check-migrations.test.ts, and importing this file
// must not fire a database query or call process.exit() under the test runner.
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main();
}
