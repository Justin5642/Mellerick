import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { TIME_ENTRY_COLUMNS } from "../../lib/time-entry-columns";
import { TIME_ENTRY_COLUMNS as MOBILE_TIME_ENTRY_COLUMNS } from "../../mobile/lib/timeEntryColumns";

/**
 * Migration 0045 dropped the TABLE-level SELECT grant on `time_entries` and
 * re-granted every column except `rate_override`. Under column-level grants
 * Postgres refuses `select *` outright — `*` expands to the revoked column.
 *
 * On 4 Aug 2026 that took web clock-in and clock-out down in production, and
 * nobody noticed, because the call sites discarded the error. 0045's own header
 * asserted "no query does `select *` on time_entries"; five call sites already
 * did.
 *
 * A mocked test cannot catch this — the mock happily returns rows for a query
 * the real database refuses. So this is a SOURCE scan, the same shape as
 * sync-streams-contract.test.ts.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const SCAN_DIRS = ["app", "components", "lib", "mobile/components", "mobile/lib"];
const SKIP_DIRS = new Set(["node_modules", ".next", "dist", ".expo", "__snapshots__"]);

// These two DEFINE the safe list; they naturally contain the column names.
const NOT_A_CALLER = new Set(["time-entry-columns.ts", "timeEntryColumns.ts"]);

function sourceFiles(dir: string): string[] {
  const abs = join(REPO_ROOT, dir);
  let entries: string[];
  try {
    entries = readdirSync(abs);
  } catch {
    return [];
  }
  return entries.flatMap((name) => {
    if (SKIP_DIRS.has(name)) return [];
    const full = join(abs, name);
    if (statSync(full).isDirectory()) return sourceFiles(join(dir, name));
    if (!/\.(ts|tsx)$/.test(name)) return [];
    if (NOT_A_CALLER.has(name)) return [];
    return [full];
  });
}

const ALL_SOURCES = SCAN_DIRS.flatMap(sourceFiles);

describe("time_entries reads must name columns explicitly (migration 0045)", () => {
  it("scans a non-trivial number of files — guards against the walker silently finding nothing", () => {
    expect(ALL_SOURCES.length).toBeGreaterThan(50);
  });

  it("no source file does select(\"*\") on time_entries", () => {
    const offenders: string[] = [];

    for (const file of ALL_SOURCES) {
      const src = readFileSync(file, "utf8");
      if (!src.includes('from("time_entries")')) continue;

      // Inspect the chain that follows each .from("time_entries"), stopping at
      // the NEXT .from( — otherwise a sibling query inside the same
      // Promise.all([...]) is swallowed and its select("*") on a DIFFERENT
      // table is misattributed. (That false positive was real: the first
      // version of this test flagged lib/labour-billing-sync.ts:69 because the
      // billing_rate_config query two lines below it does select("*").)
      const pattern = /\.from\(\s*["'`]time_entries["'`]\s*\)((?:(?!\.from\()[\s\S]){0,600})/g;
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(src)) !== null) {
        const chain = match[1];
        // `.select("*"` or `.select("*, ...` — with or without an embed.
        if (/\.select\(\s*["'`]\s*\*/.test(chain)) {
          const line = src.slice(0, match.index).split("\n").length;
          offenders.push(`${file.replace(REPO_ROOT, "").replace(/\\/g, "/")}:${line}`);
        }
      }
    }

    expect(
      offenders,
      `select("*") on time_entries is REFUSED by production under 0045's column-level grants.\n` +
        `Use TIME_ENTRY_SELECT_WITH_STAFF instead. Offending sites:\n  ${offenders.join("\n  ")}`
    ).toEqual([]);
  });

  it("never selects rate_override from a browser/session client", () => {
    expect(TIME_ENTRY_COLUMNS).not.toContain("rate_override");
    expect(MOBILE_TIME_ENTRY_COLUMNS).not.toContain("rate_override");
  });

  it("the web and mobile column lists are identical", () => {
    // Two packages, two lockfiles, no workspace — the list is duplicated by
    // necessity. This is what stops the copies drifting.
    expect(MOBILE_TIME_ENTRY_COLUMNS).toBe(TIME_ENTRY_COLUMNS);
  });

  it("the column list matches what the migrations actually create", () => {
    // Derived from the migration history rather than hand-maintained: a column
    // added by a future migration and not added here would be granted by
    // reapply_time_entries_grants() but never fetched — readable yet absent,
    // the quiet half of the same bug.
    const migrationsDir = join(REPO_ROOT, "supabase", "migrations");
    const known = new Set<string>();

    const createBlock = readFileSync(join(migrationsDir, "0000_baseline.sql"), "utf8")
      .match(/create table time_entries\s*\(([\s\S]*?)\n\);/i);
    expect(createBlock, "could not locate create table time_entries in 0000_baseline.sql").toBeTruthy();
    for (const raw of createBlock![1].split("\n")) {
      const col = raw.trim().match(/^([a-z_][a-z0-9_]*)\s+/i);
      if (col && !/^(primary|foreign|unique|check|constraint)$/i.test(col[1])) known.add(col[1]);
    }

    for (const file of readdirSync(migrationsDir).sort()) {
      const sql = readFileSync(join(migrationsDir, file), "utf8");
      for (const m of sql.matchAll(
        /alter table (?:public\.)?time_entries\s+add column (?:if not exists )?([a-z_][a-z0-9_]*)/gi
      )) {
        known.add(m[1]);
      }
    }

    known.delete("rate_override"); // revoked by 0045, deliberately not fetched

    const listed = new Set(TIME_ENTRY_COLUMNS.split(", "));
    const missing = [...known].filter((c) => !listed.has(c));
    const extra = [...listed].filter((c) => !known.has(c));

    expect(missing, `columns exist in the migrations but are never fetched: ${missing.join(", ")}`).toEqual([]);
    expect(extra, `columns fetched but created by no migration: ${extra.join(", ")}`).toEqual([]);
  });
});
