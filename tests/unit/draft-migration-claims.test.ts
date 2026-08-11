import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

// ============================================================================
// Code must not describe an UNAPPLIED migration as though it were in force.
//
// Four comments did. components/job/job-photos.tsx said "Migration 0049 scopes
// both to office/admin or the job's assigned technician, so a refusal is now
// reachable"; mobile/lib/data/gateway.supabase.ts said job_photos rows "are now
// deletable only by office/admin or the assigned technician". 0049 is drafted
// and not applied — production's only job_photos policy is still
// 0000_baseline.sql:165, `for all using (auth.role() = 'authenticated')`.
//
// The CODE was right either way: checking `count` and asking whether the row
// survived is correct under both policies. Only the tense was wrong, and a
// wrong tense here is not cosmetic — it is what let a user-facing string say
// "You can only delete photos on jobs assigned to you" for a rule nothing
// enforced, and it is how the next reader concludes a protection exists.
//
// DERIVED, NOT LISTED. The draft set comes from the migration headers, so the
// day someone applies 0049 and updates its header, every comment about it stops
// being required to carry the caveat and this guard gets out of the way by
// itself. A hardcoded list would have to be remembered, which is the failure
// mode it exists to prevent.
// ============================================================================

const REPO = join(__dirname, "..", "..");
const MIGRATIONS = join(REPO, "supabase", "migrations");
const ROOTS = ["app", "components", "lib", join("mobile", "lib"), join("mobile", "components"), join("mobile", "app")];

/**
 * Migration numbers whose own STATUS line says they are not applied.
 *
 * The STATUS LINE, not the header text. Searching the header for "NOT APPLIED"
 * anywhere caught 0036 and 0038 — both applied, both of which mention the
 * phrase while explaining that an EARLIER header wrongly claimed it. A guard
 * against stale claims that is itself confused by prose about stale claims is
 * not much of a guard.
 */
function draftNumbers(): string[] {
  return readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .filter((f) => {
      const status = readFileSync(join(MIGRATIONS, f), "utf8")
        .split(/\r?\n/)
        .find((l) => /^--\s*STATUS:/i.test(l));
      return status !== undefined && /\bDRAFT\b|NOT APPLIED/i.test(status);
    })
    .map((f) => f.slice(0, 4));
}

function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const e of entries) {
      if (e === "node_modules" || e === ".next" || e.startsWith(".")) continue;
      const p = join(dir, e);
      try {
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.tsx?$/.test(e)) out.push(p);
      } catch {
        // the tree can change under a long run
      }
    }
  };
  for (const r of ROOTS) walk(join(REPO, r));
  return out;
}

/**
 * The contiguous comment block a line belongs to.
 *
 * Block-scoped rather than line-scoped because these comments are paragraphs:
 * the caveat is allowed to sit two lines from the migration number, which is
 * how a human would actually write it.
 */
function commentBlockAround(lines: string[], index: number): string {
  const isComment = (l: string) => /^\s*(\/\/|\*|\/\*)/.test(l);
  if (!isComment(lines[index])) return lines[index];
  let start = index;
  while (start > 0 && isComment(lines[start - 1])) start--;
  let end = index;
  while (end < lines.length - 1 && isComment(lines[end + 1])) end++;
  return lines.slice(start, end + 1).join("\n");
}

const drafts = draftNumbers();
const files = sourceFiles();

describe("code does not claim an unapplied migration is in force", () => {
  it("found the drafts and something to scan", () => {
    // Vacuity guard: with no drafts, or no files, everything below passes for
    // free — which is the shape of failure this whole suite keeps finding.
    expect({ drafts: drafts.length > 0, files: files.length > 50 }).toEqual({ drafts: true, files: true });
  });

  it("every comment naming a draft migration says it is not applied", () => {
    const offenders: string[] = [];

    for (const file of files) {
      let src: string;
      try {
        src = readFileSync(file, "utf8");
      } catch {
        continue;
      }
      const lines = src.split("\n");

      for (const n of drafts) {
        const pattern = new RegExp(`\\b(migration\\s+)?${n}\\b`, "i");
        for (let i = 0; i < lines.length; i++) {
          if (!/^\s*(\/\/|\*|\/\*)/.test(lines[i])) continue;
          if (!pattern.test(lines[i])) continue;

          const block = commentBlockAround(lines, i);
          // "DRAFT", "NOT APPLIED" or an explicit conditional ("would", "once
          // it is applied") all count — the requirement is that the reader is
          // told, not that a particular word is used.
          if (/\bdraft(ed)?\b|not applied|would\b|once .* applied|if .* applied/i.test(block)) break;

          offenders.push(
            `${relative(REPO, file).replace(/\\/g, "/")}:${i + 1} names migration ${n} without saying it is unapplied`
          );
          break;
        }
      }
    }

    // To fix one: say the migration is drafted, or write the claim in the
    // conditional. Do NOT delete the reference — knowing which migration a
    // piece of defensive code anticipates is the useful part.
    expect(offenders.sort()).toEqual([]);
  });
});
