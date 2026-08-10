import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// Schema created outside the migration history is how this project keeps
// diverging from its own record, and it has now cost real time five times:
//
//   0040  jobs.ready_to_invoice        captured after the app broke
//   0041  jobs.admin_status/admin_notes captured after a drift hunt
//   0043  time_entries.hours + job_variations.attachment_file_name
//   0049  job-audio, backflow-certificates, job-documents — three storage
//         buckets that existed in production and in NO migration, so a database
//         rebuilt from the history carried policies for buckets it did not have
//   —     and the device schema that went stale behind a wildcard stream
//
// scripts/check-schema-drift.mjs compares production against the history and
// catches all of these — but it needs the service-role key, and CI deliberately
// holds no secrets, so it can only ever be run by hand. Nobody ran it. That is
// how a guard that works stays useless.
//
// This is the half that needs no credentials and therefore actually runs. It
// cannot see production; it can see the repo creating schema somewhere the
// history will not record, which is where every one of the failures above
// began. Static, offline, and in the default `unit` job.

const REPO = process.cwd();
const MIGRATIONS = join(REPO, "supabase", "migrations");
const SCRIPTS = join(REPO, "scripts");

const migrationSql = readdirSync(MIGRATIONS)
  .filter((f) => f.endsWith(".sql"))
  .sort()
  .map((f) => readFileSync(join(MIGRATIONS, f), "utf8"))
  .join("\n");

/** Bucket ids the migration history declares. */
function declaredBuckets(): Set<string> {
  const out = new Set<string>();
  for (const block of migrationSql.matchAll(/insert into storage\.buckets[\s\S]*?values\s*([\s\S]*?);/gi)) {
    for (const v of block[1].matchAll(/\(\s*'([^']+)'/g)) out.add(v[1]);
  }
  return out;
}

/** Bucket ids any script creates, resolved through a `const X = "..."` if needed. */
function scriptBuckets(): Array<{ file: string; bucket: string }> {
  const found: Array<{ file: string; bucket: string }> = [];
  for (const file of readdirSync(SCRIPTS).filter((f) => f.endsWith(".mjs"))) {
    const src = readFileSync(join(SCRIPTS, file), "utf8");

    const consts = new Map<string, string>();
    for (const m of src.matchAll(/const\s+([A-Z_][A-Z0-9_]*)\s*=\s*["']([^"']+)["']/g)) {
      consts.set(m[1], m[2]);
    }

    for (const m of src.matchAll(/createBucket\(\s*([^,)]+)/g)) {
      const arg = m[1].trim();
      const literal = arg.match(/^["']([^"']+)["']$/);
      const bucket = literal ? literal[1] : consts.get(arg);
      if (bucket) found.push({ file, bucket });
    }
  }
  return found;
}

describe("schema is not created outside the migration history", () => {
  it("still finds the migrations and the scripts", () => {
    // A parser that quietly matched nothing would make every assertion below
    // pass while checking nothing — the same reason .github/workflows/ci.yml
    // asserts a migration count before trusting a rebuilt database.
    expect(migrationSql.length).toBeGreaterThan(10_000);
    expect(readdirSync(SCRIPTS).filter((f) => f.endsWith(".mjs")).length).toBeGreaterThan(3);
    expect(declaredBuckets().size).toBeGreaterThan(0);
  });

  it("declares every bucket a script creates", () => {
    // A script that creates a bucket is fine — buckets are awkward to make in
    // SQL and 0006 said so. What is not fine is the bucket existing ONLY there:
    // rebuild from migrations and it is missing, so every storage policy on it
    // silently governs nothing, and every storage test passes by reading an
    // empty set.
    const declared = declaredBuckets();
    const undeclared = scriptBuckets()
      .filter(({ bucket }) => !declared.has(bucket))
      .map(({ file, bucket }) => `${file} creates "${bucket}", which no migration declares`);

    expect(undeclared).toEqual([]);
  });

  // Scripts that READ DDL rather than run it. check-schema-drift.mjs exists to
  // parse `create table` and `add column` out of the migration history and
  // compare it to production — mentioning the syntax is its entire job.
  //
  // Named individually rather than filtered by a rule, because separating
  // "mentions DDL" from "executes DDL" statically is guesswork, and a rule that
  // guesses would eventually wave through the real thing. A second file
  // appearing here has to argue for itself in review.
  const DDL_READERS = ["check-schema-drift.mjs"];

  it("creates no TABLE or COLUMN from a script", () => {
    // Buckets have a defensible reason to be script-created — 0006 gave it, and
    // the previous test makes sure the migration history still declares them.
    // Tables and columns have no such excuse, and a script quietly adding one
    // reproduces the 0040 / 0041 / 0043 sequence exactly.
    const offenders: string[] = [];
    for (const file of readdirSync(SCRIPTS).filter((f) => f.endsWith(".mjs"))) {
      if (DDL_READERS.includes(file)) continue;
      const src = readFileSync(join(SCRIPTS, file), "utf8");
      const code = src
        .split("\n")
        .filter((l) => !l.trim().startsWith("//"))
        .join("\n");
      if (/\b(create table|alter table[\s\S]{0,80}?add column|drop column)\b/i.test(code)) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("keeps the DDL-reader exemption honest", () => {
    // The exemption above is the one place this guard can be silently widened,
    // so the exempt files must still exist and must still be readers. If
    // check-schema-drift.mjs is ever rewritten to APPLY a migration, this is
    // the line that should stop being true.
    for (const file of DDL_READERS) {
      const src = readFileSync(join(SCRIPTS, file), "utf8");
      expect(/new RegExp|match\(|matchAll\(/.test(src)).toBe(true);
      expect(/\.rpc\(|execFileSync\(\s*["']psql|query\(/.test(src)).toBe(false);
    }
  });
});
