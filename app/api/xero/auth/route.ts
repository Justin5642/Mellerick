import { NextRequest, NextResponse } from "next/server";
import { getXeroClient } from "@/lib/xero";
import { createOAuthState, stateCookieOptions, XERO_STATE_COOKIE } from "@/lib/oauth-state";
import { requireAdmin } from "@/lib/api/guards";

// Starts the Xero OAuth connect flow. Admin-only: connecting Xero decides which
// Xero org the business's invoices push to, so only an admin may initiate it
// (and the callback re-checks — see callback/route.ts).
export async function GET(request: NextRequest) {
  const guard = await requireAdmin(request);
  if (!guard.ok) return guard.response;

  const xero = getXeroClient();
  // Same reasoning as the Google flow: requireAdmin proves the CALLER is an
  // admin, which is exactly who a CSRF link targets. state proves the callback
  // belongs to a flow WE started.
  const state = createOAuthState();
  const consentUrl = new URL(await xero.buildConsentUrl());
  consentUrl.searchParams.set("state", state);

  const res = NextResponse.redirect(consentUrl.toString());
  res.cookies.set(XERO_STATE_COOKIE, state, stateCookieOptions());
  return res;
}
