// The schema as the MIGRATION HISTORY defines it — table, column and type —
// parsed from text so it is available without a database.
//
// Two guards need this and had been deriving it separately, which is its own
// drift risk: schema-column-contract.test.ts (does the source name a column
// that no migration creates?) and device-schema-vs-migrations.test.ts (item
// 2.24 — does the generated PowerSync schema still match?).
//
// WHY THE MIGRATION HISTORY AND NOT THE LIVE DATABASE. The generated device
// schema is produced from live Postgres, so checking it against live proves
// only that a generator ran against something. The migration history is the
// representation the repo controls and CI rebuilds from; comparing against it
// is what catches "a migration landed and nobody regenerated". `npm run
// check:drift` covers the other direction, migrations against production.

/** Column name -> the raw Postgres type token the migration declared. */
export type TableColumns = Map<string, string>;

/**
 * Strip everything after the type from a column definition's tail.
 *
 * A migration column reads `is_active boolean not null default true`, and a
 * greedy match takes the constraints with it — which is not cosmetic: the
 * resulting "boolean not null default true" falls through every case in
 * sqliteType() to `text`, and the check then reports fifteen type mismatches
 * that do not exist. Ask for the first identifier only, plus an optional
 * precision and array suffix.
 *
 * `serial unique` therefore yields `serial`, and `numeric(10,2)` yields
 * `numeric(10,2)` — both of which the normaliser below understands.
 */
const COLUMN_RE = /^"?(\w+)"?\s+([a-z_]+(?:\s*\(\s*\d+(?:\s*,\s*\d+)?\s*\))?(?:\[\])?)/i;

/** Reserved words that begin a table-level clause rather than a column. */
const NOT_A_COLUMN = /^(primary key|foreign key|unique|check|constraint|references|exclude|like)\b/i;

/**
 * Every table the migration history creates, with its columns and their types.
 *
 * `create table` bodies first, then `alter table … add column` folded in, then
 * `drop column` removed — in file order, so the result is the schema as it
 * stands at the end of the history rather than at any point during it.
 */
export function migrationTables(sql: string): Map<string, TableColumns> {
  const out = new Map<string, TableColumns>();

  const tableRe = /create table (?:if not exists )?(\w+)\s*\(([\s\S]*?)\n\);/gi;
  for (const [, table, body] of sql.matchAll(tableRe)) {
    const cols: TableColumns = new Map();
    for (const line of body.split("\n")) {
      const t = line.trim();
      if (!t || NOT_A_COLUMN.test(t)) continue;
      const m = t.match(COLUMN_RE);
      if (m) cols.set(m[1], m[2].trim().toLowerCase());
    }
    out.set(table, cols);
  }

  // `[^;]*?` is load-bearing: without it the gap spans whole files and pairs an
  // early `alter table` with a much later `add column`, silently losing real
  // columns. Same reasoning as schema-column-contract.test.ts.
  const addRe =
    /alter table (?:only )?(\w+)[^;]*?add column (?:if not exists )?"?(\w+)"?\s+([a-z_]+(?:\s*\(\s*\d+(?:\s*,\s*\d+)?\s*\))?(?:\[\])?)/gi;
  for (const [, table, col, type] of sql.matchAll(addRe)) {
    if (!out.has(table)) out.set(table, new Map());
    out.get(table)!.set(col, type.trim().toLowerCase());
  }

  // No migration in this tree drops or renames a column today. Handling drops
  // anyway costs three lines and means the first one does not silently leave a
  // ghost column in the expected schema. Renames are NOT handled: they would
  // need ordering that this text pass does not model, so a rename must fail
  // loudly here rather than be guessed at.
  const dropRe = /alter table (?:only )?(\w+)[^;]*?drop column (?:if exists )?"?(\w+)"?/gi;
  for (const [, table, col] of sql.matchAll(dropRe)) out.get(table)?.delete(col);

  return out;
}

/**
 * Normalise a migration's type token to the spelling `information_schema`
 * reports, which is what the PowerSync generator's sqliteType() switches on.
 *
 * The generator reads live Postgres, so it sees `integer` where the migration
 * wrote `serial`, and `numeric` where it wrote `decimal(10,2)`. Without this
 * translation the two representations look different when they are identical,
 * and the guard cries wolf on every numeric and boolean column in the schema.
 */
export function toInformationSchemaType(migrationType: string): string {
  const base = migrationType
    .replace(/\s*\(.*\)/, "")
    .replace(/\[\]$/, "")
    .trim();
  const aliases: Record<string, string> = {
    int: "integer",
    int4: "integer",
    integer: "integer",
    serial: "integer",
    bigint: "bigint",
    int8: "bigint",
    bigserial: "bigint",
    smallint: "smallint",
    int2: "smallint",
    smallserial: "smallint",
    bool: "boolean",
    boolean: "boolean",
    numeric: "numeric",
    decimal: "numeric",
    float8: "double precision",
    "double precision": "double precision",
    real: "real",
    float4: "real",
  };
  return aliases[base] ?? base;
}
