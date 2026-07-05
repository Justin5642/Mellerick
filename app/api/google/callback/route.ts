import { NextRequest, NextResponse } from "next/server";
import { google } from "googleapis";
import { getGoogleOAuthClient } from "@/lib/google";
import { createClient } from "@/lib/supabase/server";

export async function GET(request: NextRequest) {
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
    await supabase.from("google_tokens").delete().neq("id", "00000000-0000-0000-0000-000000000000");
    await supabase.from("google_tokens").insert({
      access_token: tokens.access_token!,
      refresh_token: tokens.refresh_token!,
      token_expiry: new Date(tokens.expiry_date!).toISOString(),
      google_email: userinfo.email,
    });

    return NextResponse.redirect(new URL("/dashboard/settings?google=connected", request.url));
  } catch (err) {
    console.error("Google callback error:", err);
    return NextResponse.redirect(new URL("/dashboard/settings?google=error", request.url));
  }
}
