import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

// A RATCHET, not a sweep.
//
// This codebase's signature defect is a write that reports success while doing
// nothing. It has produced, in order: a clock-in that recorded no time, an
// RLS-denied edit reported as saved, a geofence leg computed from identical
// timestamps, a storage delete that silently kept the file, an invoice edit that
// destroyed every line, a Xero connect that destroyed the connection it was
// replacing, and a bill push that could pay a supplier twice.
//
// Every one began the same way: `await supabase.from(…).update(…)` with the
// result discarded. supabase-js does not throw on a database error — it resolves
// `{ data, error }` — so an unchecked mutation is indistinguishable from a
// successful one, and the surrounding try/catch never fires.
//
// The mobile app has a structural guard for its read layer
// (mobile/lib/data/reads/noSwallowedErrors.test.ts). The web app has none, and a
// verbatim port will not work: it relies on a shared read seam that does not
// exist here.
//
// It began as a RATCHET: eighteen existing offenders across eleven files were
// listed and allowed, and only a NEW one failed the build. That list is now
// EMPTY — every one of the eighteen has been checked, and the guard has stopped
// being a ratchet and become an absolute rule.
//
// Which means the note that used to live here — "numbers may go DOWN, never
// up" — no longer applies. There is no number to lower. Adding a file back to
// the allowlist is not maintenance, it is a decision to ship the defect this
// file exists to prevent, and it should be argued for in a PR rather than
// typed into a constant.
//
// The deletes are the part worth understanding before editing any of them:
// checking `error` alone is NOT enough. PostgREST returns no error for an
// UPDATE or DELETE that matches zero rows, so an RLS refusal and a success are
// byte-identical responses. Those sites check `count` as well, which is the
// only thing that tells them apart.

const REPO = process.cwd();
// `lib` was missing, and its absence made the claim at the top of this file
// false. "The allowlist is empty, so the guard is now an absolute rule" was
// true of two directories out of three — and the third is where the billing
// and integration code lives. Adding it surfaced thirteen unchecked writes,
// six of them on the labour-billing path that decides what a customer is
// charged.
//
// The sibling guard service-role-seam.test.ts already walked all three, so
// this was an inconsistency rather than a considered scope.
const ROOTS = ["app", "components", "lib"];

/** Every .ts/.tsx file under the scanned roots. */
function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(full);
    }
  };
  for (const r of ROOTS) walk(join(REPO, r));
  return out;
}

/**
 * A mutation whose result is thrown away.
 *
 * Matches `await <something>.from(…)…<mutation>(` only when the statement does
 * NOT begin with an assignment — `const { error } = await …` is the checked
 * form. Deliberately conservative: it looks at the start of the statement, so
 * anything assigned anywhere counts as checked even if the caller then ignores
 * the variable. Catching that too would need real flow analysis; catching the
 * discarded-outright case is what stops the recurring defect.
 */
function uncheckedMutations(src: string): string[] {
  const hits: string[] = [];
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // The statement must START with `await` — `const { error } = await …` is
    // the checked form and is not a hit.
    if (!/^\s*await\s+\w/.test(line)) continue;

    // ONE STATEMENT, NOT ONE LINE, and that distinction was a real hole.
    //
    // This used to require `await` and `.from(` on the SAME line, so the
    // idiomatic multi-line form
    //
    //     await supabase
    //       .from("jobs")
    //       .update({ … })
    //       .eq("id", id);
    //
    // was invisible to it. Two writes in lib/google.ts — added by the very
    // change that extended this guard to `lib` — were exactly that shape. A
    // guard that only sees code formatted one way is a guard against
    // formatting, and it was described in the handover as an absolute rule.
    //
    // Cut at the first `;` so the window cannot run past the end of this
    // statement and borrow a `.from(` from the one below it.
    const rest = lines.slice(i, i + 12).join("\n");
    const semicolon = rest.indexOf(";");
    const statement = semicolon === -1 ? rest : rest.slice(0, semicolon);

    if (!/\.from\(/.test(statement)) continue;
    if (/\.(insert|update|upsert|delete)\s*\(/.test(statement)) {
      hits.push(`${i + 1}: ${line.trim().slice(0, 90)}`);
    }
  }
  return hits;
}

describe("unchecked supabase mutations", () => {
  const files = sourceFiles();

  it("scans a meaningful number of files", () => {
    // A walker that silently matched nothing would make the assertion below
    // trivially true, which is the failure mode this whole file exists to
    // prevent.
    expect(files.length).toBeGreaterThan(50);
  });

  it("does not grow the list of writes whose result is discarded", () => {
    const found: Record<string, number> = {};
    for (const file of files) {
      const hits = uncheckedMutations(readFileSync(file, "utf8"));
      if (hits.length) found[relative(REPO, file).replace(/\\/g, "/")] = hits.length;
    }

    // Empty, and meant to stay that way. See the note at the top before adding
    // anything back.
    const ALLOWED: Record<string, number> = ALLOWLIST;

    const regressions: string[] = [];
    for (const [file, count] of Object.entries(found)) {
      const allowed = ALLOWED[file] ?? 0;
      if (count > allowed) regressions.push(`${file}: ${count} unchecked (allowed ${allowed})`);
    }

    expect(regressions).toEqual([]);
  });
});

// Empty as of 2026-08-11. It held eighteen entries across eleven files:
//
//   app/api/google/disconnect/route.ts                        1
//   app/dashboard/approvals/page.tsx                          2
//   app/dashboard/fleet/page.tsx                              1
//   app/dashboard/quotes/new/page.tsx                         1
//   app/dashboard/settings/cost-centre-templates/page.tsx     2
//   app/dashboard/settings/variation-types/page.tsx           4
//   components/job/job-equipment.tsx                          1
//   components/job/job-line-items.tsx                         1
//   components/job/job-po.tsx                                 2
//   components/job/job-variations.tsx                         1
//   components/quote/quote-detail.tsx                         2
//
// Kept as a comment rather than deleted, because the list is the evidence that
// this guard was worth writing.
const ALLOWLIST: Record<string, number> = {};
