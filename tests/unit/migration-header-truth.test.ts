import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { claimsNotApplied } from "../../scripts/migration-header-claim.mjs";

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

describe("the three headers corrected on 2026-08-05 stay corrected", () => {
  // Regression pin. These are applied in production; if any reverts to claiming
  // otherwise, that is the exact drift this whole exercise was about.
  for (const name of ["0035", "0036", "0037", "0038"]) {
    it(`${name} does not claim to be unapplied`, () => {
      const file = readdirSync(MIGRATIONS).find((f) => f.startsWith(name));
      expect(file, `no migration found for ${name}`).toBeTruthy();
      const src = readFileSync(join(MIGRATIONS, file as string), "utf8");
      expect(claimsNotApplied(src)).toBe(false);
    });
  }
});
