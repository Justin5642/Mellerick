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
 *
 * Accepts an optional Supabase client so callers without a browser session
 * (e.g. a cron job using the service-role client) can reuse the same logic.
 */
export async function getGoogleCalendarClient(supabaseClient?: any) {
  const supabase = supabaseClient ?? (await createClient());
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

/**
 * Pulls changes made *directly in Google Calendar* (drag to reschedule,
 * resize, or delete an event) back onto the matching job — the other half
 * of the one-way (app -> calendar) push in /api/jobs/[id]/sync-calendar.
 *
 * Shared by the cron-driven poll route and the Settings page's manual
 * "Sync now" button, so both take the exact same code path. Callers pass
 * whichever Supabase client they have (service-role for cron, cookie-based
 * for the logged-in manual trigger).
 */
export async function pollGoogleCalendarChanges(supabase: any) {
  const { data: tokenRow } = await supabase.from("google_tokens").select("*").single();
  if (!tokenRow) return { skipped: true, reason: "Google Calendar not connected" };

  const calendar = await getGoogleCalendarClient(supabase);
  if (!calendar) return { skipped: true, reason: "Google Calendar not connected" };

  const syncToken: string | undefined = tokenRow.calendar_sync_token ?? undefined;
  let pageToken: string | undefined;
  let nextSyncToken: string | undefined;
  let updated = 0;
  let clearedByDeletion = 0;
  let skipped = 0;

  // If we don't have a sync token yet, scope the initial listing to "from
  // now on" so we don't walk years of calendar history on the first run.
  const isInitialSync = !syncToken;

  do {
    let res;
    try {
      res = await calendar.events.list({
        calendarId: "primary",
        syncToken,
        pageToken,
        singleEvents: true,
        showDeleted: true,
        ...(isInitialSync ? { timeMin: new Date().toISOString() } : {}),
      });
    } catch (e: any) {
      // 410 Gone means the stored sync token is no longer valid (too old,
      // or calendar history was purged). Drop it so the next run re-seeds
      // from scratch instead of failing forever.
      if (e?.code === 410) {
        await supabase.from("google_tokens").update({ calendar_sync_token: null }).eq("id", tokenRow.id);
        return { resyncRequired: true };
      }
      throw e;
    }

    for (const event of res.data.items ?? []) {
      if (!event.id) continue;
      const { data: job } = await supabase
        .from("jobs")
        .select("id, scheduled_start, scheduled_end, status")
        .eq("google_event_id", event.id)
        .maybeSingle();
      if (!job) {
        skipped++;
        continue;
      }

      if (event.status === "cancelled") {
        // Event was deleted directly in Google Calendar — clear the
        // schedule so office staff notice the job needs re-booking, rather
        // than silently leaving a stale schedule in place.
        await supabase
          .from("jobs")
          .update({ scheduled_start: null, scheduled_end: null, google_event_id: null })
          .eq("id", job.id);
        clearedByDeletion++;
        continue;
      }

      const newStart = event.start?.dateTime ?? event.start?.date ?? null;
      const newEnd = event.end?.dateTime ?? event.end?.date ?? null;
      const startChanged =
        newStart && new Date(newStart).toISOString() !== (job.scheduled_start ? new Date(job.scheduled_start).toISOString() : null);
      const endChanged =
        newEnd && new Date(newEnd).toISOString() !== (job.scheduled_end ? new Date(job.scheduled_end).toISOString() : null);

      if (startChanged || endChanged) {
        await supabase
          .from("jobs")
          .update({
            scheduled_start: newStart ? new Date(newStart).toISOString() : job.scheduled_start,
            scheduled_end: newEnd ? new Date(newEnd).toISOString() : job.scheduled_end,
          })
          .eq("id", job.id);
        updated++;
      }
    }

    pageToken = res.data.nextPageToken ?? undefined;
    if (res.data.nextSyncToken) nextSyncToken = res.data.nextSyncToken;
  } while (pageToken);

  await supabase
    .from("google_tokens")
    .update({
      calendar_sync_token: nextSyncToken ?? syncToken ?? null,
      calendar_last_synced_at: new Date().toISOString(),
    })
    .eq("id", tokenRow.id);

  return { updated, clearedByDeletion, skipped, initialSync: isInitialSync };
}
