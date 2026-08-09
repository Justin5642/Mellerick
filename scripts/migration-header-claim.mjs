// Does a migration's HEADER claim it has not been applied?
//
// Kept separate from check-migration-headers.mjs so the claim-detection is a
// pure function with no database access, and can be pinned by a unit test that
// runs in CI (which has no production credentials).
//
// WHY THIS EXISTS. A header saying "PROPOSED (not applied)" after the migration
// HAS been applied is not cosmetic. `supabase db push` applies whatever the
// ledger lacks; it does not read comments. So a stale "do NOT auto-apply" header
// protects nothing and misleads everything:
//
//   0035, 0038  claimed the dollar-leak boundary was "not in force" for about a
//               week after it was in force
//   0036        implied push was blocked on a database change, hiding the real
//               blocker (APNs/FCM credentials) behind a false one
//   0037        its own header records that the stale version "had misled three
//               code comments"

/**
 * Only the LEADING comment block is examined. A migration body may legitimately
 * mention another migration's status, and the file's own claim is made at the
 * top or nowhere.
 */
function headerOf(source) {
  const lines = String(source).split("\n");
  const header = [];
  for (const line of lines) {
    const t = line.trim();
    if (t === "" || t.startsWith("--")) {
      header.push(t);
      continue;
    }
    break; // first non-comment line ends the header
  }
  return header.join("\n");
}

// "PROPOSED", "NOT APPLIED", "not yet applied", "DRAFT ... NOT APPLIED".
const CLAIMS = [/\bPROPOSED\b/i, /\bnot\s+(yet\s+)?applied\b/i];

// A CORRECTED header narrates the old claim while asserting the opposite. Those
// must not be flagged, or the guard cries wolf on precisely the files that
// document the fix — and a guard that cries wolf gets deleted rather than obeyed.
const APPLIED = [/\bAPPLIED AND VERIFIED\b/i, /✅\s*APPLIED/i, /\bSTATUS:\s*✅/i];

export function claimsNotApplied(source) {
  const header = headerOf(source);
  if (APPLIED.some((re) => re.test(header))) return false;
  return CLAIMS.some((re) => re.test(header));
}
