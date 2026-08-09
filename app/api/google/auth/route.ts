import { NextRequest, NextResponse } from "next/server";
import { getGoogleConsentUrl } from "@/lib/google";
import { createOAuthState, stateCookieOptions, GOOGLE_STATE_COOKIE } from "@/lib/oauth-state";
import { requireAdmin } from "@/lib/api/guards";

// Starts the Google Calendar OAuth connect flow. Admin-only: connecting a
// calendar decides which Google account jobs sync to, so only an admin may
// initiate it (the callback re-checks — see callback/route.ts).
export async function GET(request: NextRequest) {
  const guard = await requireAdmin(request);
  if (!guard.ok) return guard.response;

  // Mint a one-time state and keep it in an HttpOnly cookie. requireAdmin above
  // does NOT cover the real attack: an outsider sends an ADMIN a callback link
  // carrying the outsider's OAuth code, the admin check passes because the
  // victim is an admin, and the calendar syncs to the attacker's account.
  const state = createOAuthState();
  const res = NextResponse.redirect(getGoogleConsentUrl(state));
  res.cookies.set(GOOGLE_STATE_COOKIE, state, stateCookieOptions());
  return res;
}
