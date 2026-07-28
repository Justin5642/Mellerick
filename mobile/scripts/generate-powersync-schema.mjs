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
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
// CommonJS on purpose: jest transforms .js but not .mjs, so the pure logic
// lives in a .js module both this ESM script and the test suite can load.
import schemaLib from './powersync-schema-lib.js';
const { parseStreams, render } = schemaLib;

const HERE = dirname(fileURLToPath(import.meta.url));
const MOBILE = join(HERE, '..');
const REPO = join(MOBILE, '..');
const STREAMS = join(MOBILE, 'powersync', 'sync-streams.yaml');
const OUT = join(MOBILE, 'lib', 'powersync', 'schema.ts');

function loadColumns(offlineFile) {
  const raw = offlineFile
    ? readFileSync(offlineFile, 'utf8')
    : execFileSync(
        process.platform === 'win32' ? 'npx.cmd' : 'npx',
        [
          'supabase', 'db', 'query', '--linked',
          "select table_name, column_name, data_type from information_schema.columns where table_schema = 'public' order by table_name, ordinal_position",
        ],
        { cwd: REPO, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }
      );
  const json = JSON.parse(raw.slice(raw.indexOf('{')));
  const byTable = new Map();
  for (const r of json.rows) {
    if (!byTable.has(r.table_name)) byTable.set(r.table_name, []);
    byTable.get(r.table_name).push({ name: r.column_name, pg: r.data_type });
  }
  return byTable;
}

const offlineFlag = process.argv.indexOf('--offline');
const synced = parseStreams(readFileSync(STREAMS, 'utf8'));
const byTable = loadColumns(offlineFlag > -1 ? process.argv[offlineFlag + 1] : null);
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, render(synced, byTable));
console.log(`wrote ${OUT} — ${synced.size} tables`);
