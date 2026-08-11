#!/usr/bin/env node
// Generates mobile/lib/powersync/schema.ts from the two sources of truth:
//
//   1. mobile/powersync/sync-streams.yaml  — WHICH tables/columns are synced
//   2. the live Postgres schema             — what TYPE each column is
//
// Hand-writing the client schema guarantees drift: a column added to a stream,
// or a Postgres type change, silently produces a device table that cannot hold
// the value. Regenerate instead:
//
//   node mobile/scripts/generate-powersync-schema.mjs
//
// Requires the Supabase CLI to be linked (supabase/.temp/project-ref); it reads
// the schema via `supabase db query --linked`, so no database password is
// needed. Pass --offline <file.json> to use a previously captured dump instead
// (shape: `{ rows: [{ table_name, column_name, data_type }] }`).
//
// The pure logic lives in powersync-schema-lib.mjs so it can be unit-tested.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
// CommonJS on purpose: jest transforms .js but not .mjs, so the pure logic
// lives in a .js module both this ESM script and the test suite can load.
import schemaLib from './powersync-schema-lib.js';
// The CLI-output parser is shared with the web check scripts. It used to be
// duplicated inline here, and that copy carried a bug all three copies had —
// see scripts/supabase-cli-json.mjs for the measured output-shape matrix.
import { parseCliRows } from '../../scripts/supabase-cli-json.mjs';
const { parseStreams, render, columnsByTable } = schemaLib;

const HERE = dirname(fileURLToPath(import.meta.url));
const MOBILE = join(HERE, '..');
const REPO = join(MOBILE, '..');
const STREAMS = join(MOBILE, 'powersync', 'sync-streams.yaml');
const OUT = join(MOBILE, 'lib', 'powersync', 'schema.ts');

const COLUMNS_SQL =
  "select table_name, column_name, data_type from information_schema.columns " +
  "where table_schema = 'public' order by table_name, ordinal_position";

function queryColumnsViaCli() {
  // Two things this has to get right, both learned the hard way elsewhere in the
  // repo and neither of which the previous version did:
  //
  // 1. shell: true on Windows. Since Node 20, execFileSync of a bare `npx.cmd`
  //    throws `spawnSync npx.cmd EINVAL` — the exact error a human got when they
  //    followed this file's own "Regenerate: node mobile/scripts/..." instruction.
  //    scripts/gen-types.mjs and the two check scripts all already know this.
  //
  // 2. The SQL travels by FILE, not as an inline argument. Under shell: true
  //    cmd.exe re-parses the arguments and mangles the embedded quotes and `%`,
  //    so an inline statement reaches the CLI broken. A temp file sidesteps it.
  //
  // --output-format json stops the CLI printing a box-drawing table to a
  // terminal; parseCliRows handles the two JSON shapes that remain.
  const file = join(tmpdir(), `mellerick-powersync-schema-${process.pid}.sql`);
  writeFileSync(file, COLUMNS_SQL, 'utf8');
  try {
    return execFileSync(
      'npx',
      ['supabase', 'db', 'query', '--linked', '--output-format', 'json', '--file', file],
      { cwd: REPO, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, shell: process.platform === 'win32' }
    );
  } finally {
    try {
      unlinkSync(file);
    } catch {
      /* best effort — a stray temp file is not worth failing regeneration over */
    }
  }
}

function loadColumns(offlineFile) {
  const raw = offlineFile ? readFileSync(offlineFile, 'utf8') : queryColumnsViaCli();
  return columnsByTable(parseCliRows(raw));
}

const offlineFlag = process.argv.indexOf('--offline');
const synced = parseStreams(readFileSync(STREAMS, 'utf8'));
const byTable = loadColumns(offlineFlag > -1 ? process.argv[offlineFlag + 1] : null);
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, render(synced, byTable));
console.log(`wrote ${OUT} — ${synced.size} tables`);
