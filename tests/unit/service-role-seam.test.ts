import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

// lib/supabase/admin.ts claims a property for itself:
//
//   "The ONE place the service-role key is turned into a client. This key
//    bypasses all row-level security, so keeping its construction in a single
//    grep-able module (rather than inlined per-route) makes it auditable and
//    gives tests a single seam to mock."
//
// It was not true. Four routes built their own client inline — staff/invite,
// staff/resend-invite, staff/update and transcribe-voice-report — so 4 of the
// service-role call sites were invisible to the seam that exists to make them
// visible. Not a live hole, since all four authorize first, but a claim a file
// makes about itself should be enforced rather than hoped for; nothing stopped
// a fifth.
//
// This is the enforcement. It is cheap because the property is syntactic: the
// key may be NAMED in exactly two places.

const REPO = process.cwd();

/** Every source file under the app's own directories. */
function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(full);
    }
  };
  for (const r of ["app", "lib", "components"]) walk(join(REPO, r));
  return out;
}

// The only two files allowed to name the key: the seam that constructs the
// client, and the env module that declares it required.
const ALLOWED = ["lib/supabase/admin.ts", "lib/env.ts"];

describe("the service-role key has exactly one construction site", () => {
  const files = sourceFiles();

  it("scans a meaningful number of files", () => {
    // Without this, a broken walker would make the assertion below vacuous —
    // the same failure this repo has hit repeatedly.
    expect(files.length).toBeGreaterThan(50);
  });

  it("is named only by the admin seam and the env declaration", () => {
    const offenders = files
      .filter((f) => readFileSync(f, "utf8").includes("SUPABASE_SERVICE_ROLE_KEY"))
      .map((f) => relative(REPO, f).replace(/\\/g, "/"))
      .filter((f) => !ALLOWED.includes(f))
      .sort();

    // A new route needing service-role access should import createAdminClient,
    // not rebuild the client. If you are adding one here, that is the fix.
    expect(offenders).toEqual([]);
  });

  it("still actually constructs a client in the seam, rather than passing vacuously", () => {
    // If admin.ts were gutted, the assertion above would go green for the wrong
    // reason: nothing names the key because nothing uses it.
    const seam = readFileSync(join(REPO, "lib/supabase/admin.ts"), "utf8");
    expect(seam).toContain("SUPABASE_SERVICE_ROLE_KEY");
    expect(seam).toMatch(/export function createAdminClient/);
  });
});
