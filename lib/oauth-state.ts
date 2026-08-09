import { randomBytes, timingSafeEqual } from "node:crypto";

// CSRF protection for the Xero and Google OAuth connect flows.
//
// THE ATTACK, which the Xero callback's own comment already describes:
//
//   "an attacker who obtains an OAuth code for THEIR own Xero org could
//    repoint the business's invoicing by hitting this URL directly"
//
// The callback answers that with requireAdmin — and requireAdmin does not stop
// it. The attack is not "an outsider calls the callback"; it is "an outsider
// gets an ADMIN to call the callback", by sending them a link containing the
// attacker's own OAuth code. The admin check passes, because the victim really
// is an admin. The business's invoices then push to the attacker's Xero org, and
// the calendar syncs to their Google account.
//
// `state` is what closes it: a random value minted when the flow STARTS, kept in
// an HttpOnly cookie the attacker cannot read or set, and required to match when
// the callback returns. A forged callback carries no matching cookie, so it is
// refused before any token is exchanged.
//
// Kept as pure functions over cookie values so the decision is testable without
// standing up an OAuth provider.

/** Cookie names, one per provider so connecting one cannot consume the other's state. */
export const XERO_STATE_COOKIE = "mellerick_xero_oauth_state";
export const GOOGLE_STATE_COOKIE = "mellerick_google_oauth_state";

/** 32 bytes of CSPRNG, hex — long enough that guessing is not a strategy. */
export function createOAuthState(): string {
  return randomBytes(32).toString("hex");
}

/**
 * Does the state returned by the provider match the one we issued?
 *
 * Fails closed on every ambiguous input: a missing cookie, a missing query
 * value, or a length mismatch all return false. Compared in constant time —
 * the values are short-lived, but a comparison that leaks position is free to
 * avoid and awkward to explain later.
 */
export function isValidOAuthState(cookieValue: string | undefined, queryValue: string | null): boolean {
  if (!cookieValue || !queryValue) return false;

  const a = Buffer.from(cookieValue, "utf8");
  const b = Buffer.from(queryValue, "utf8");
  // timingSafeEqual throws on differing lengths, which would itself be a signal.
  if (a.length !== b.length) return false;

  return timingSafeEqual(a, b);
}

/** Cookie attributes: unreadable to script, not sent cross-site, short-lived. */
export function stateCookieOptions(): {
  httpOnly: true;
  secure: boolean;
  sameSite: "lax";
  path: string;
  maxAge: number;
} {
  return {
    httpOnly: true,
    // Lax, not Strict: the provider redirects the user BACK to us cross-site, and
    // Strict would withhold the cookie on exactly that navigation, breaking the
    // flow it is meant to protect.
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 600, // 10 minutes is longer than any real consent screen takes
  };
}
