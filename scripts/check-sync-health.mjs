#!/usr/bin/env node
// Is PowerSync actually still replicating? Answer in one command.
//
// WHY THIS EXISTS
// On 2026-08-04 replication was found to have been dead for 24 HOURS. The
// logical replication slot had been invalidated by Postgres (`wal_removed` —
// the slot fell behind far enough that Postgres discarded WAL it still needed).
//
// Nothing surfaced it. That is the entire point of this script:
//
//   - technician devices kept syncing, and reported themselves healthy
//   - the client's own ps_sync_state timestamp kept advancing
//   - no client error fired, because the CLIENT was fine
//   - reads silently fell back to the network, so screens still showed data
//
// The only symptom was that nothing written after the invalidation ever reached
// a device. A job assigned to a technician would simply never arrive, and the
// app would look completely normal while it happened.
//
// WHY THIS AND NOT AN ALERTING PIPELINE
// This is a ~10-technician business, not a platform team. Synthetic canary
// writes, a propagation-latency monitor and an alert pipeline are all
// infrastructure that itself needs monitoring and maintenance — and a monitor
// that dies quietly is WORSE than none, because it converts "nobody is looking"
// into "everybody believes it is fine". One command with an unambiguous verdict
// can be run by a person, from CI, or from a cron, and cannot rot silently:
// if it breaks, it fails loudly the next time it runs.
//
// USAGE
//   node scripts/check-sync-health.mjs        (or: npm run check:sync)
//
// Requires the Supabase CLI linked to the project (supabase/.temp/project-ref).
// Read-only. Exits 1 when replication is unhealthy, so it can gate a release
// or run unattended.

import { execFileSync } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseCliRows, singleJsonColumn } from "./supabase-cli-json.mjs";

// `active` is the load-bearing column: a slot with no reader attached is a
// dead feed regardless of how healthy everything else looks. `wal_status` of
// 'lost' means the slot is unrecoverable and must be recreated by redeploying
// the sync rules — the exact state that cost 24 hours.
// Deliberately ONE LINE. On Windows this is passed through `shell: true`, and a
// multi-line argument is split by the shell — the CLI then receives a truncated
// statement and returns an empty row, which this script would have to interpret
// as "unhealthy". A health check that cries wolf gets ignored, so the failure
// mode is worth this formatting cost.
const SQL =
  "select coalesce(json_agg(row_to_json(t)), '[]'::json)::text from (" +
  "select slot_name, active, coalesce(wal_status, 'unknown') as wal_status, " +
  "coalesce(pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), confirmed_flush_lsn)), 'unknown') as behind " +
  "from pg_replication_slots where slot_name like 'powersync%') t";

function runSql(sql) {
  // The SQL goes through a FILE, not the command line.
  //
  // Passing it as an argument needs `shell: true` on Windows (Node refuses to
  // spawn npx.cmd without one), and cmd.exe then re-parses the string — the
  // embedded quotes and the `%` wildcard get mangled, the CLI receives a broken
  // statement, and it returns an empty row that this script would report as
  // "replication is down". A false alarm from a health check is worse than no
  // health check, so the quoting problem is removed rather than escaped around.
  const file = join(tmpdir(), `mellerick-sync-health-${process.pid}.sql`);
  writeFileSync(file, sql, "utf8");
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

function query(sql) {
  // Both the shape-handling and the refusal live in supabase-cli-json.mjs,
  // shared with check-migrations.mjs. This script had its own copy of that
  // parse, check-migrations had another, and both copies carried the same bug —
  // so fixing one would have left the other broken. It did.
  const rows = parseCliRows(runSql(sql));

  // No rows means no replication slot, which main() reports as an outage. That
  // reading is only safe because parseCliRows THROWS on anything it does not
  // recognise: an unreadable output can never arrive here disguised as "empty".
  return singleJsonColumn(rows) ?? [];
}

/**
 * The verdict, as a pure function of the slot rows — exported and unit-tested in
 * tests/unit/sync-health-verdict.test.ts, over in the web project because that
 * is where the runner lives.
 *
 * This is deliberately separate from the I/O. A health check whose ALARM path
 * has never run is the failure mode that makes monitoring worse than useless:
 * it converts "nobody is looking" into "everybody believes it is fine". The
 * healthy path proves itself every time it runs; the unhealthy paths only ever
 * run during an outage, which is the worst moment to discover a typo in them.
 *
 * Returns { healthy, reason } — `reason` is the machine-readable cause, and the
 * caller owns the human-facing text.
 */
export function verdict(slots) {
  if (!Array.isArray(slots) || slots.length === 0) return { healthy: false, reason: "no-slot" };
  // Invalidation is checked BEFORE inactivity: a lost slot is also inactive, and
  // reporting it as merely "no reader attached" would send the reader chasing a
  // credential problem instead of redeploying, which is what actually fixes it.
  if (slots.some((s) => s.wal_status === "lost")) return { healthy: false, reason: "invalidated" };
  if (slots.some((s) => !s.active)) return { healthy: false, reason: "no-reader" };
  return { healthy: true, reason: "ok" };
}

function main() {
  let slots;
  try {
    slots = query(SQL);
  } catch (e) {
    console.error("FAILED to query the database. Is the Supabase CLI linked, and run from the repo root?");
    console.error(String(e.message || e).split("\n").slice(0, 6).join("\n"));
    process.exit(1);
  }

  const v = verdict(slots);

  if (v.reason === "no-slot") {
    console.error("UNHEALTHY: no PowerSync replication slot exists at all.");
    console.error("");
    console.error("  Nothing is replicating from Postgres into PowerSync. Devices will keep");
    console.error("  syncing whatever snapshot PowerSync already holds, and will never see a");
    console.error("  new or changed row.");
    console.error("");
    console.error("  Fix: redeploy the sync rules in the PowerSync dashboard — that creates a");
    console.error("  fresh slot and re-snapshots.");
    process.exit(1);
  }

  const lost = slots.filter((s) => s.wal_status === "lost");

  for (const s of slots) {
    const state = s.active ? "active" : "INACTIVE";
    console.log(`  ${s.slot_name}  ${state}  wal_status=${s.wal_status}  behind=${s.behind}`);
  }
  console.log("");

  if (v.reason === "invalidated") {
    console.error("UNHEALTHY: a slot has been INVALIDATED (wal_status='lost').");
    console.error("");
    console.error("  Postgres discarded WAL this slot still needed. It cannot resume — this is");
    console.error("  the exact failure that went unnoticed for 24 hours on 2026-08-04.");
    console.error("");
    console.error("  Fix: redeploy the sync rules in the PowerSync dashboard (creates a fresh");
    console.error("  slot), then drop the invalidated one:");
    for (const s of lost) {
      console.error(`      select pg_drop_replication_slot('${s.slot_name}');`);
    }
    console.error("");
    console.error("  Prevent: raise max_slot_wal_keep_size on the Supabase instance.");
    process.exit(1);
  }

  if (v.reason === "no-reader") {
    console.error("UNHEALTHY: a PowerSync slot exists but has NO READER attached (active=false).");
    console.error("");
    console.error("  PowerSync is not connected to Postgres. New rows will not reach any device,");
    console.error("  and NOTHING on the client will report a problem.");
    console.error("");
    console.error("  Check the PowerSync dashboard Issues/Logs panel FIRST — it names the cause");
    console.error("  exactly. Do NOT start by rotating the database password: an inactive slot");
    console.error("  looks identical whether the cause is a bad credential, a saved-but-never-");
    console.error("  deployed connection, or an invalidated slot.");
    process.exit(1);
  }

  console.log(`HEALTHY: ${slots.length} PowerSync slot(s), all active, none invalidated.`);
  process.exit(0);
}

// Only run when invoked as a script. `verdict` is imported by
// tests/unit/sync-health-verdict.test.ts, and importing this file must not fire
// a database query or call process.exit() out from under the test runner.
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main();
}
