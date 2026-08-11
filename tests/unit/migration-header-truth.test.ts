import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { claimsNotApplied, claimsApplied, headerOf } from "../../scripts/migration-header-claim.mjs";

// A migration header that says "PROPOSED (not applied)" after it HAS been
// applied is not a cosmetic error.
//
// `supabase db push` applies whatever the ledger lacks. It does not read
// comments. So a stale "do NOT auto-apply" header protects nothing, while
// actively misleading everyone who reads it:
//
//   • 0035 and 0038 both claimed the dollar-leak boundary was "not in force"
//     for about a week after it was in force
//   • 0036 implied push was blocked on a database change, hiding the real
//     blocker (APNs/FCM credentials) behind a false one
//   • 0037's own header records that its stale version "had misled three code
//     comments"
//
// This test cannot ask production what is applied — CI has no credentials for
// it. What it CAN do is pin the claim-detection itself, so the companion script
// (`npm run check:migrations`, which does query the ledger) cannot silently stop
// recognising the phrasing it is looking for.

const MIGRATIONS = join(process.cwd(), "supabase", "migrations");

describe("claimsNotApplied — recognises the phrasings actually used in this repo", () => {
  it("detects the exact 0035 wording", () => {
    expect(claimsNotApplied("-- STATUS: PROPOSED (mobile/full-parity branch). Authored...")).toBe(true);
  });

  it("detects the exact 0036 wording", () => {
    expect(claimsNotApplied("-- PROPOSED (not applied) — flagged for Justin's review, like 0035.")).toBe(true);
  });

  it("detects the exact 0038 wording", () => {
    expect(claimsNotApplied("-- STATUS: PROPOSED (not applied). The shared `supabase/` schema...")).toBe(true);
  });

  it("detects 'DRAFT ... NOT APPLIED', which 0047 and 0048 use", () => {
    expect(claimsNotApplied("-- STATUS: DRAFT FOR REVIEW — NOT APPLIED. Justin owns the database.")).toBe(true);
  });

  it("does NOT flag a header that merely NARRATES a past stale claim", () => {
    // 0037 says its previous "PROPOSED / NOT applied" header was stale. Flagging
    // that would make the guard cry wolf on the one file that documents the fix.
    const s = `-- STATUS: ✅ APPLIED AND VERIFIED IN PRODUCTION (2026-07-28).
-- The previous "PROPOSED / NOT applied" header was stale and had misled three
-- code comments (see below).`;
    expect(claimsNotApplied(s)).toBe(false);
  });

  it("does NOT flag an applied header that tells the reader to verify", () => {
    const s = `-- STATUS: ✅ APPLIED AND VERIFIED IN PRODUCTION. Confirmed 2026-08-05.
-- Verify, do not trust this comment:
--   select * from supabase_migrations.schema_migrations where version like '0035%';`;
    expect(claimsNotApplied(s)).toBe(false);
  });

  it("only reads the HEADER, not the whole file", () => {
    // A migration body may legitimately contain the word in a comment about
    // another migration; only the leading comment block states this file's own
    // status.
    const s = "-- STATUS: ✅ APPLIED.\n\ncreate table x();\n-- note: 0099 is PROPOSED (not applied)\n";
    expect(claimsNotApplied(s)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// EVERY header on disk, checked — not a list of four written down in 2026-08.
//
// This block used to loop a hardcoded ["0035","0036","0037","0038"] and assert
// only that those four do not claim to be unapplied. Five migrations added
// since — 0049 through 0053 — each carry `-- STATUS: DRAFT — NOT APPLIED.`,
// and each names a guard that fails the build if that line outlives the apply.
// They were enforced by NOTHING: the loop could not see them, and a hardcoded
// list can never see the file added tomorrow. The list is derived from the
// directory now, so a migration cannot arrive outside the guard's view.
//
// WHAT THIS CAN AND CANNOT PROVE. It still cannot ask production what is
// applied — CI holds no credentials, and `npm run check:migrations` is where
// that comparison lives. What it CAN prove is that a header says ONE thing, and
// that `claimsNotApplied` — the detector the ledger check reads headers with —
// still sees what a plain reading of that header says. A detector that quietly
// stops recognising the phrasing in front of it turns the ledger check into a
// rubber stamp that reports every draft as honest.

const files = readdirSync(MIGRATIONS)
  .filter((f) => f.endsWith(".sql"))
  .sort();

const sourceOf = (f: string) => readFileSync(join(MIGRATIONS, f), "utf8");

// A SECOND, DUMBER READING of the same header, deliberately not sharing code
// with claimsNotApplied. Two implementations that agree prove something; one
// implementation compared against itself proves nothing.
//
// Narration is stripped first. A corrected header quotes the stale claim it is
// replacing — 0035, 0036, 0037 and 0038 all do — and quoting is this repo's
// actual convention for "these words are the old lie, not my claim".
const withoutNarration = (header: string) => header.replace(/"[^"]*"/g, '""');

// `DRAFT` is required to appear in a STATUS line, while PROPOSED / NOT APPLIED
// are matched anywhere in the header. Not a convenience: "draft" is an ordinary
// word in this domain, and 0031 uses it for an unsent invoice ("office
// reviews/edits it on the draft before sending"). Keying the ambiguous word to
// the status line — which is also the literal marker CI holds drafts back on,
// see below — while leaving the unambiguous phrases broad keeps the reading
// honest rather than merely quiet.
const DRAFT_CLAIM = /\bSTATUS:[^\n]*\bDRAFT\b|\bPROPOSED\b|\bnot\s+(yet\s+)?applied\b/i;
const APPLIED_CLAIM = /✅|\bAPPLIED(\s+AND\s+VERIFIED)?\s+IN\s+PRODUCTION\b/i;

describe("every migration header on disk", () => {
  it("is actually there to be checked", () => {
    // A directory read that returned nothing would make every assertion below
    // vacuously true and the suite green — the precise failure this repo keeps
    // finding. Assert the corpus exists, and that at least one file in it makes
    // a status claim, before trusting anything derived from it.
    expect(files.length).toBeGreaterThan(0);
    const claiming = files.filter((f) => {
      const h = withoutNarration(headerOf(sourceOf(f)));
      return DRAFT_CLAIM.test(h) || APPLIED_CLAIM.test(h);
    });
    expect(claiming.length, "no migration header states a status at all").toBeGreaterThan(0);
  });

  it("does not claim to be applied and unapplied at the same time", () => {
    const contradictory = files.filter((f) => {
      const h = withoutNarration(headerOf(sourceOf(f)));
      return DRAFT_CLAIM.test(h) && APPLIED_CLAIM.test(h);
    });
    // Editing "DRAFT — NOT APPLIED" into "APPLIED IN PRODUCTION" without
    // removing the old line leaves a file that reads as whichever half you
    // happen to look at, and the two guards that read it disagree: CI still
    // holds it back as a draft while the ledger check calls it honest.
    expect(contradictory, "header states both statuses").toEqual([]);
  });

  it("is read the same way by claimsNotApplied as by a plain reading", () => {
    const disagreements = files
      .map((f) => {
        const src = sourceOf(f);
        const plain = DRAFT_CLAIM.test(withoutNarration(headerOf(src)));
        return { f, plain, detector: claimsNotApplied(src) };
      })
      .filter((r) => r.plain !== r.detector)
      .map((r) => `${r.f}: header reads as ${r.plain ? "NOT applied" : "applied/unstated"}, detector says ${r.detector ? "NOT applied" : "applied/unstated"}`);
    // Either the header found a phrasing the detector does not know, or the
    // detector is flagging something that is not a claim. Both make
    // `npm run check:migrations` compare the wrong thing against the ledger.
    expect(disagreements).toEqual([]);
  });

  it("is read the same way by claimsApplied as by a plain reading", () => {
    // The other direction, and the one the ledger check can actually catch a
    // file lying about: a header asserting it is live in production while the
    // ledger has never heard of it.
    const disagreements = files
      .map((f) => {
        const src = sourceOf(f);
        return { f, plain: APPLIED_CLAIM.test(withoutNarration(headerOf(src))), detector: claimsApplied(src) };
      })
      .filter((r) => r.plain !== r.detector)
      .map((r) => `${r.f}: header reads as ${r.plain ? "applied" : "unstated"}, detector says ${r.detector ? "applied" : "unstated"}`);
    expect(disagreements).toEqual([]);
  });
});

describe("the draft marker CI holds back on", () => {
  // THE THIRD READER OF THESE HEADERS. scripts/ci-apply-migrations.sh greps a
  // literal string to decide which files represent production and which are
  // handed-over drafts applied only so their own test suites can run. If a
  // draft's header ever states its claim in wording that grep misses, CI
  // applies it alongside production's migrations and then "proves" a security
  // policy that production does not have — the circularity that script's own
  // header describes at length.
  //
  // The pattern is read out of the script rather than written down here, so the
  // two cannot drift apart silently.
  const sh = readFileSync(join(process.cwd(), "scripts", "ci-apply-migrations.sh"), "utf8");
  const patterns = [...sh.matchAll(/grep\s+-q\s+"([^"]+)"/g)].map((m) => m[1]);

  it("is a single literal, found in the CI script", () => {
    expect(patterns.length, "no `grep -q \"…\"` in ci-apply-migrations.sh").toBeGreaterThan(0);
    expect([...new Set(patterns)], "CI greps for more than one draft marker").toHaveLength(1);
  });

  it("appears in exactly the files whose headers claim to be unapplied", () => {
    const marker = [...new Set(patterns)][0];
    const byMarker = files.filter((f) => sourceOf(f).includes(marker)).sort();
    const byClaim = files.filter((f) => claimsNotApplied(sourceOf(f))).sort();
    // Held back by CI but not read as a draft = CI is excluding a migration
    // production has. Read as a draft but not held back = CI is applying a
    // migration production does not have, and asserting against it.
    expect(byMarker).toEqual(byClaim);
  });
});
