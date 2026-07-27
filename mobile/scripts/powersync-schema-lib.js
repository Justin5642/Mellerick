// Pure logic behind generate-powersync-schema.mjs, kept free of any node:
// imports and of side effects so it can be unit-tested directly.

// Extracts, per Postgres table, the union of columns selected across every
// stream that reads it — or 'ALL' if any stream selects `*` / `table.*`.
// Deliberately a narrow parser for the shapes sync-streams.yaml actually uses
// (SELECT list ... FROM table [JOIN ...] [WHERE ...]) rather than general SQL.
function parseStreams(yaml) {
  const queries = [];
  const lines = yaml.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\s*query:\s*(\|?)(.*)$/);
    if (!m) continue;
    if (m[1] === '|') {
      const block = [];
      for (let j = i + 1; j < lines.length; j++) {
        if (lines[j].trim() === '') { block.push(''); continue; }
        if (!/^\s{6,}/.test(lines[j])) break;
        block.push(lines[j].trim());
      }
      queries.push(block.join(' ').trim());
    } else {
      queries.push(m[2].trim());
    }
  }

  const synced = new Map(); // table -> Set<string> | 'ALL'
  for (const q of queries) {
    const sel = q.match(/^SELECT\s+([\s\S]*?)\s+FROM\s+([a-z_][a-z0-9_]*)/i);
    if (!sel) continue;
    const [, columnList, table] = sel;
    const cols = columnList.split(',').map((c) => c.trim());
    const selectsAll = cols.some((c) => c === '*' || c === `${table}.*`);
    if (selectsAll) { synced.set(table, 'ALL'); continue; }
    if (synced.get(table) === 'ALL') continue;
    const set = synced.get(table) ?? new Set();
    for (const c of cols) set.add(c.replace(new RegExp(`^${table}\\.`), ''));
    synced.set(table, set);
  }
  return synced;
}

// PowerSync's SQLite has exactly three column types, applied as a CAST over
// json_extract — the declared type decides what JS type a query returns.
// Postgres numeric maps to `real` because that is what the Supabase/PostgREST
// path already returns (JSON numbers): the fallback must be byte-identical,
// and 2-decimal money is exact well inside double range. Mappers still guard
// with num() for defence in depth.
function sqliteType(pgType) {
  switch (pgType) {
    case 'integer':
    case 'bigint':
    case 'smallint':
      return 'integer';
    case 'boolean':
      return 'integer'; // SQLite has no bool: 0/1
    case 'double precision':
    case 'real':
    case 'numeric':
      return 'real';
    default:
      return 'text'; // text, uuid, timestamptz, date, jsonb, arrays
  }
}

function render(synced, byTable) {
  const tables = [...synced.keys()].sort();
  const out = [];
  out.push('// GENERATED FILE — do not edit by hand.');
  out.push('// Regenerate: node mobile/scripts/generate-powersync-schema.mjs');
  out.push('//');
  out.push('// The device-side SQLite schema, derived from the DEPLOYED sync streams');
  out.push('// (mobile/powersync/sync-streams.yaml) and the live Postgres column types.');
  out.push('//');
  out.push('// SECURITY NOTE — read before assuming this file enforces the money contract:');
  out.push('// this schema is the UNION of every stream, so money columns DO appear here');
  out.push('// (e.g. job_variations.rate). That is not a leak: a technician matches only');
  out.push('// the rate-stripped tech streams, so those columns stay NULL on their device,');
  out.push('// and the office streams yield them zero rows. The guarantee is "no money');
  out.push('// VALUES for a technician", not "no money columns in the schema".');
  out.push('//');
  out.push('// Numeric columns are declared `real` so local reads return JS numbers,');
  out.push('// matching what the Supabase/PostgREST fallback returns.');
  out.push('');
  out.push("import { column, Schema, Table } from '@powersync/common';");
  out.push('');

  for (const t of tables) {
    const cols = byTable.get(t);
    if (!cols) throw new Error(`table ${t} is in sync-streams.yaml but not in the database`);
    const want = synced.get(t);
    const chosen = want === 'ALL' ? cols : cols.filter((c) => want.has(c.name));
    if (want !== 'ALL') {
      const missing = [...want].filter((w) => w !== 'id' && !cols.some((c) => c.name === w));
      if (missing.length) throw new Error(`${t}: stream selects unknown column(s) ${missing.join(', ')}`);
    }
    const body = chosen
      .filter((c) => c.name !== 'id') // id is implicit in PowerSync
      .map((c) => `  ${c.name}: column.${sqliteType(c.pg)},`);
    out.push(`const ${t} = new Table({`);
    out.push('  // id (text) is implicit');
    out.push(...body);
    out.push('});');
    out.push('');
  }

  out.push('export const AppSchema = new Schema({');
  for (const t of tables) out.push(`  ${t},`);
  out.push('});');
  out.push('');
  out.push('export type Database = (typeof AppSchema)["types"];');
  out.push('');
  return out.join('\n');
}

module.exports = { parseStreams, sqliteType, render };
