import { describe, it, expect } from "vitest";
import { timingSafeEquals } from "../../lib/constant-time";

// Two places compared a shared secret with a short-circuiting operator:
//
//   lib/api/guards.ts:90            authorization !== `Bearer ${cronSecret}`
//   supabase/functions/send-push    providedSecret === internalSecret
//
// Both now go through this. The tests below pin behaviour, not timing —
// asserting on elapsed time would be flaky on CI and would prove nothing about
// the property anyway, since `timingSafeEqual` is where the guarantee lives.
// What is worth pinning is that the wrapper cannot be tricked into agreeing.

describe("timingSafeEquals", () => {
  it("accepts an exact match", () => {
    expect(timingSafeEquals("s3cret-token", "s3cret-token")).toBe(true);
  });

  it("rejects a different value of the same length", () => {
    expect(timingSafeEquals("s3cret-token", "s3cret-tokeX")).toBe(false);
  });

  it("rejects a prefix rather than throwing", () => {
    // node's timingSafeEqual throws on differing lengths. Unhandled, that turns
    // a wrong secret into a 500 — which is both a bug and a louder signal than
    // the 401 it should have been.
    expect(() => timingSafeEquals("s3cret", "s3")).not.toThrow();
    expect(timingSafeEquals("s3cret", "s3")).toBe(false);
    expect(timingSafeEquals("s3", "s3cret")).toBe(false);
  });

  it("rejects null, undefined and non-strings without throwing", () => {
    // A missing header is the common case, not an edge case: every unauthorised
    // request arrives with no Authorization at all.
    expect(timingSafeEquals(null, "s3cret")).toBe(false);
    expect(timingSafeEquals(undefined, "s3cret")).toBe(false);
    expect(timingSafeEquals("s3cret", null)).toBe(false);
    expect(timingSafeEquals(undefined, undefined)).toBe(false);
  });

  it("does not treat two empty strings as a match", () => {
    // If the configured secret is somehow empty, an empty header must not
    // authorise the request. guards.ts refuses a missing CRON_SECRET before
    // reaching here, and this is the second line of that defence.
    expect(timingSafeEquals("", "")).toBe(false);
  });

  it("compares by bytes, so multi-byte characters cannot collide", () => {
    expect(timingSafeEquals("é", "e")).toBe(false);
    expect(timingSafeEquals("é", "é")).toBe(true);
  });
});
