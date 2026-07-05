import { google } from "googleapis";
import { createClient } from "@/lib/supabase/server";

const SCOPES = [
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/userinfo.email",
];

export function getGoogleOAuthClient() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
}

export function getGoogleConsentUrl() {
  const oauth2Client = getGoogleOAuthClient();
  return oauth2Client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: SCOPES,
  });
}

/**
 * Returns an authenticated Google Calendar client for the single connected
 * account, refreshing (and persisting) the access token if it's expired.
 * Returns null if no Google account is connected — callers should treat
 * this as "skip calendar sync", not as an error.
 */
export async function getGoogleCalendarClient() {
  const supabase = await createClient();
  const { data: tokenRow } = await supabase.from("google_tokens").select("*").single();
  if (!tokenRow) return null;

  const oauth2Client = getGoogleOAuthClient();
  oauth2Client.setCredentials({
    access_token: tokenRow.access_token,
    refresh_token: tokenRow.refresh_token,
    expiry_date: new Date(tokenRow.token_expiry).getTime(),
  });

  if (new Date(tokenRow.token_expiry).getTime() < Date.now() + 60_000) {
    const { credentials } = await oauth2Client.refreshAccessToken();
    oauth2Client.setCredentials(credentials);
    await supabase
      .from("google_tokens")
      .update({
        access_token: credentials.access_token!,
        token_expiry: new Date(credentials.expiry_date!).toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", tokenRow.id);
  }

  return google.calendar({ version: "v3", auth: oauth2Client });
}
