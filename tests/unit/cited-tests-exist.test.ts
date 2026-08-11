import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, basename } from "node:path";

// A comment that names the guard covering it is the cheapest documentation in
// this repo — and the easiest to leave pointing at nothing.
//
// mobile/powersync/sync-streams.yaml told every reader that
// `lib/powersync/readColumns.test.ts` asserts every column the offline read
// layer names exists on the device. That file has never existed. The guard it
// describes is real — mobile/lib/data/reads/sqlLint.test.ts — so a reader who
// went looking, found nothing, and concluded the column contract was unguarded
// would have been wrong twice: wrong that it was missing, and wrong about where
// to add it. The same shape sat in scripts/check-sync-health.mjs, which cited
// `check-sync-health.test.mjs` for a verdict function actually tested in
// tests/unit/sync-health-verdict.test.ts.
//
// Neither was catchable by anything. A stale reference costs a reader a search;
// a stale reference to a SAFETY guard costs them their belief about whether the
// thing is guarded at all, which is this project's most expensive currency —
// see the four SQL security tests that had never run, and HANDOVER-HARDENING.md
// §5 on the check and the thing being checked not being the same thing.
//
// Scope is deliberately the whole repository, both npm projects, docs included.
// Narrowing it to the web app would leave exactly the file the defect was found
// in outside the net. Everything is read as TEXT and nothing is imported — a
// web test that imports a mobile/ module dies on the second tsconfig
// (HANDOVER-HARDENING.md §6 trap 8).

const ROOT = join(__dirname, "..", "..");

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".next",
  ".expo",
  "coverage",
  "dist",
  "build",
  "test-results",
  "playwright-report",
  ".claude",
]);

const READABLE = /\.(tsx|ts|jsx|js|mjs|md|ya?ml|sql|json)$/;

function walk(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(join(ROOT, dir || "."), { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const rel = dir ? `${dir}/${entry.name}` : entry.name;
    if (entry.isDirectory()) walk(rel, acc);
    else acc.push(rel);
  }
  return acc;
}

const everyFile = walk("");
const namesOnDisk = everyFile.map(f => basename(f));

// `foo.test.ts`, `a/b/foo.spec.tsx`, `foo.guard.test.ts`, `*.local.test.ts`.
const CITATION = /([A-Za-z0-9_.*/-]*[A-Za-z0-9_*-]+\.(?:test|spec)\.(?:tsx|ts|jsx|js|mjs))/g;

/**
 * A citation is satisfied when a file of that name exists somewhere in the
 * repository. Matching on the basename rather than the full path is the point:
 * prose legitimately writes `sqlLint.test.ts` for a file three directories
 * down, and a guard that demanded exact paths would fail on correct references
 * and teach people to stop naming their guards.
 *
 * A leading `*` is a glob the prose actually means — `*.local.test.ts` stands
 * for ten real files — so it is satisfied by any name ending that way.
 */
function isSatisfied(citation: string): boolean {
  const name = basename(citation);
  if (name.startsWith("*") || name.startsWith(".")) {
    const suffix = name.replace(/^\*/, "");
    return namesOnDisk.some(onDisk => onDisk.endsWith(suffix));
  }
  return namesOnDisk.includes(name);
}

describe("every test file named in the repository exists", () => {
  it("names no guard that is not on disk", () => {
    const dangling: string[] = [];

    for (const file of everyFile) {
      if (!READABLE.test(file)) continue;
      // This file quotes the dead names on purpose — they are the worked
      // example, and the case-test below asserts the resolver still rejects
      // them. It is the one file in the repository where a citation that
      // resolves to nothing is the point rather than the defect.
      if (file === "tests/unit/cited-tests-exist.test.ts") continue;
      let source: string;
      try {
        source = readFileSync(join(ROOT, file), "utf8");
      } catch {
        continue;
      }
      for (const [, citation] of source.matchAll(CITATION)) {
        if (!isSatisfied(citation)) dangling.push(`${file} cites ${citation}`);
      }
    }

    expect([...new Set(dangling)].sort()).toEqual([]);
  });

  it("is actually looking at both projects and at prose", () => {
    // Without this the guard above could pass by scanning nothing, which is the
    // failure mode it exists to catch. These three are the corners: the mobile
    // project, a non-code file type, and the docs.
    expect(everyFile).toContain("mobile/powersync/sync-streams.yaml");
    expect(everyFile).toContain("HANDOVER-HARDENING.md");
    expect(everyFile.some(f => f.startsWith("mobile/lib/"))).toBe(true);
  });

  it("would notice a name that exists nowhere", () => {
    expect(isSatisfied("lib/powersync/readColumns.test.ts")).toBe(false);
    expect(isSatisfied("check-sync-health.test.mjs")).toBe(false);
    // …while still accepting the two forms real comments use.
    expect(isSatisfied("mobile/lib/data/reads/sqlLint.test.ts")).toBe(true);
    expect(isSatisfied("*.local.test.ts")).toBe(true);
  });
});

describe("the mobile lint ceiling quoted in CI is the one that is enforced", () => {
  // .github/workflows/ci.yml told the reader the ceiling was "136 today" while
  // mobile/package.json pinned `--max-warnings 7`. The number in a comment is
  // the number people plan against — someone triaging warnings against 136
  // would conclude there were 129 to go and that CI was slack, when in fact the
  // build fails at 8.
  const workflow = readFileSync(join(ROOT, ".github/workflows/ci.yml"), "utf8");
  const mobilePackageJson = readFileSync(join(ROOT, "mobile/package.json"), "utf8");

  it("quotes the pinned --max-warnings, whatever it currently is", () => {
    const pinned = mobilePackageJson.match(/--max-warnings\s+(\d+)/);
    expect(pinned, "mobile/package.json no longer pins --max-warnings").not.toBeNull();

    const quoted = workflow.match(/ceiling is pinned in mobile\/package\.json[\s\S]{0,200}?(\d+) today/);
    expect(quoted, "ci.yml no longer states the ceiling it is describing").not.toBeNull();

    expect(quoted![1]).toBe(pinned![1]);
  });
});
