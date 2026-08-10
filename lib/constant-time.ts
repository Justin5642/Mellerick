import { timingSafeEqual } from "node:crypto";

// Comparing a secret with `===` leaks how much of it you got right.
//
// JavaScript's string comparison short-circuits at the first differing byte, so
// the time taken is a function of the shared prefix length. That is a
// distinguishable signal, and repeated measurement recovers the secret one byte
// at a time.
//
// HONEST SEVERITY: over HTTP this is hard to exploit. Network jitter is orders
// of magnitude larger than the few nanoseconds of difference, and CRON_SECRET is
// only reachable from a route that returns 401 either way. This is not the hole
// that will hurt this project. It is fixed because the fix is four lines, the
// primitive was already in the tree (lib/oauth-state.ts wrote its own), and
// "we compare secrets in constant time" is a property worth being able to state
// without qualification.
//
// The length check is deliberate and not a weakness: timingSafeEqual THROWS on
// differing lengths, so it has to happen first, and the length of a secret is
// not the part worth protecting.

/** Constant-time string comparison. False for any length mismatch, and false
 *  for empty input on either side. */
export function timingSafeEquals(a: string | null | undefined, b: string | null | undefined): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;

  // Two empty strings are byte-identical, so timingSafeEqual returns TRUE for
  // them. That is the wrong answer here: an empty configured secret would then
  // be satisfied by an empty header, and a misconfiguration would read as an
  // authorised request rather than a refused one. Fail closed instead.
  if (a.length === 0 || b.length === 0) return false;

  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;

  return timingSafeEqual(left, right);
}
