// Pure coercers from SQLite-shaped rows to the domain shapes PostgREST
// returns. SQLite has three types; the app expects numbers, booleans and
// nested objects. Every local read maps through these so the dialect
// difference lives in exactly one place.

/** numeric/text → number; PostgREST returns JSON numbers for Postgres numeric. */
export function num(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    if (!Number.isNaN(n)) return n;
  }
  return 0;
}

export function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isNaN(n) ? null : n;
}

/** SQLite 1/0 → boolean. Null stays null (nullable boolean columns exist). */
export function bool(v: unknown): boolean;
export function bool(v: null | undefined): null;
export function bool(v: unknown): boolean | null {
  if (v === null || v === undefined) return null;
  return v === 1 || v === true || v === "1";
}

/**
 * Rebuild a PostgREST to-one embed from LEFT JOIN aliases. PostgREST returns
 * `null` for the whole object when the FK is null — not `{name: null}` — and
 * screens test `row.customers?.name`, so that distinction matters.
 */
export function nestOne<T extends Record<string, unknown>>(
  fkValue: unknown,
  obj: T
): T | null {
  return fkValue === null || fkValue === undefined ? null : obj;
}

/** Group a child query's rows by FK — the local stand-in for a to-many embed. */
export function groupByKey<T, K extends keyof T>(rows: T[], key: K): Map<T[K], T[]> {
  const out = new Map<T[K], T[]>();
  for (const r of rows) {
    const k = r[key];
    const bucket = out.get(k);
    if (bucket) bucket.push(r);
    else out.set(k, [r]);
  }
  return out;
}
