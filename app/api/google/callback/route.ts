import { NextRequest, NextResponse } from "next/server";
import { google } from "googleapis";
import { getGoogleOAuthClient } from "@/lib/google";
import { createClient } from "@/lib/supabase/server";
import { requireAdmin } from "@/lib/api/guards";
import { isValidOAuthState, GOOGLE_STATE_COOKIE } from "@/lib/oauth-state";
import { replaceSingletonToken } from "@/lib/oauth-token-store";

export async function GET(request: NextRequest) {
  // Re-check admin at the callback (see xero/callback for the rationale): this
  // is where google_tokens is deleted and rewritten.
  const guard = await requireAdmin(request);
  if (!guard.ok) return guard.response;

  // CSRF. Verified BEFORE the code is exchanged: a forged callback carries the
  // attacker's code but no matching HttpOnly cookie, so it is refused before any
  // token is issued or any row is deleted. The requireAdmin above cannot do this
  // job — the attack works precisely BECAUSE the victim is an admin.
  const state = request.nextUrl.searchParams.get("state");
  const cookie = request.cookies.get(GOOGLE_STATE_COOKIE)?.value;
  if (!isValidOAuthState(cookie, state)) {
    return NextResponse.redirect(new URL("/dashboard/settings?google=state_mismatch", request.url));
  }

  const code = request.nextUrl.searchParams.get("code");
  if (!code) {
    return NextResponse.redirect(new URL("/dashboard/settings?google=error", request.url));
  }

  try {
    const oauth2Client = getGoogleOAuthClient();
    const { tokens } = await oauth2Client.getToken(code);

    if (!tokens.refresh_token) {
      // Google only returns a refresh_token on the first-ever consent for this
      // app+account. If the user previously connected then revoked partially,
      // force them to re-consent from a clean state.
      return NextResponse.redirect(new URL("/dashboard/settings?google=error", request.url));
    }

    oauth2Client.setCredentials(tokens);
    const oauth2 = google.oauth2({ version: "v2", auth: oauth2Client });
    const { data: userinfo } = await oauth2.userinfo.get();

    const supabase = await createClient();

    // Insert-then-retire, and both results checked — see the twin in
    // xero/callback and the reasoning in lib/oauth-token-store.ts. The previous
    // order deleted the working row first and never looked at either result, so
    // a failed insert left no calendar connection while reporting success.
    const stored = await replaceSingletonToken(supabase, "google_tokens", {
      access_token: tokens.access_token!,
      refresh_token: tokens.refresh_token!,
      token_expiry: new Date(tokens.expiry_date!).toISOString(),
      google_email: userinfo.email,
    });

    if (!stored.ok) {
      console.error("Google callback: token storage failed —", stored.error);
      return NextResponse.redirect(new URL("/dashboard/settings?google=error", request.url));
    }

    return NextResponse.redirect(new URL("/dashboard/settings?google=connected", request.url));
  } catch (err) {
    console.error("Google callback error:", err);
    return NextResponse.redirect(new URL("/dashboard/settings?google=error", request.url));
  }
}
