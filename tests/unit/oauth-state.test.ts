import { describe, it, expect } from "vitest";
import {
  createOAuthState,
  isValidOAuthState,
  stateCookieOptions,
  XERO_STATE_COOKIE,
  GOOGLE_STATE_COOKIE,
} from "../../lib/oauth-state";

// Neither OAuth flow sent a `state` parameter. Both callbacks relied solely on
// requireAdmin — which does not address the attack the Xero callback's own
// comment describes: an attacker sends an admin a link carrying the attacker's
// OAuth code, the admin check passes because the victim IS an admin, and the
// business's invoicing is repointed to the attacker's Xero org.

describe("createOAuthState", () => {
  it("is long enough that guessing is not a strategy", () => {
    expect(createOAuthState()).toHaveLength(64); // 32 bytes hex
  });

  it("is different every time", () => {
    const seen = new Set(Array.from({ length: 50 }, () => createOAuthState()));
    expect(seen.size).toBe(50);
  });
});

describe("isValidOAuthState", () => {
  it("accepts the state we issued", () => {
    const s = createOAuthState();
    expect(isValidOAuthState(s, s)).toBe(true);
  });

  it("REJECTS a forged callback carrying no cookie — the actual attack", () => {
    // The attacker can put anything in the URL; they cannot set an HttpOnly
    // cookie on our origin.
    expect(isValidOAuthState(undefined, createOAuthState())).toBe(false);
  });

  it("rejects a callback with no state in the query", () => {
    expect(isValidOAuthState(createOAuthState(), null)).toBe(false);
  });

  it("rejects when neither is present, rather than treating empty as a match", () => {
    expect(isValidOAuthState(undefined, null)).toBe(false);
    expect(isValidOAuthState("", "")).toBe(false);
  });

  it("rejects a mismatch", () => {
    expect(isValidOAuthState(createOAuthState(), createOAuthState())).toBe(false);
  });

  it("rejects a length mismatch without throwing", () => {
    // timingSafeEqual throws on differing lengths; that must not surface as a
    // 500, which would be both a bug and a signal.
    expect(() => isValidOAuthState("abc", "abcdef")).not.toThrow();
    expect(isValidOAuthState("abc", "abcdef")).toBe(false);
  });

  it("rejects a prefix of the real state", () => {
    const s = createOAuthState();
    expect(isValidOAuthState(s, s.slice(0, 32))).toBe(false);
  });
});

describe("stateCookieOptions", () => {
  it("is HttpOnly, so page script cannot read or forge it", () => {
    expect(stateCookieOptions().httpOnly).toBe(true);
  });

  it("uses SameSite=Lax, NOT Strict", () => {
    // The provider redirects the user back to us cross-site. Strict would
    // withhold the cookie on exactly that navigation and break the flow this
    // exists to protect — a failure that looks like "OAuth is broken" rather
    // than "the CSRF guard is misconfigured".
    expect(stateCookieOptions().sameSite).toBe("lax");
  });

  it("expires in minutes, not indefinitely", () => {
    const { maxAge } = stateCookieOptions();
    expect(maxAge).toBeGreaterThan(60);
    expect(maxAge).toBeLessThanOrEqual(900);
  });
});

describe("cookie names", () => {
  it("are distinct per provider", () => {
    // A shared name would let a Google connect consume the Xero state, and the
    // guard would pass for the wrong flow.
    expect(XERO_STATE_COOKIE).not.toBe(GOOGLE_STATE_COOKIE);
  });
});
