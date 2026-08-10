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

export function getGoogleConsentUrl(state?: string) {
  const oauth2Client = getGoogleOAuthClient();
  return oauth2Client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: SCOPES,
    // CSRF: echoed back by Google and matched against an HttpOnly cookie in
    // callback/route.ts. See lib/oauth-state.ts for the attack this closes.
    ...(state ? { state } : {}),
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
 * Which side wrote last?
 *
 * The poll below used to decide purely on "do the times differ", which cannot
 * tell a Google-side edit from an app-side edit the calendar has not caught up
 * with. Both systems stamp their own modification time — Google sets
 * `event.updated`, Postgres maintains `jobs.updated_at` via the
 * update_updated_at trigger (0000_baseline.sql:295) — so comparing them
 * distinguishes the two directions with no schema change, which matters
 * because migrations here are drafted and handed over, never applied.
 *
 * Ties go to the JOB. So does an unparseable or absent `event.updated`: when
 * it is genuinely impossible to say who wrote last, the side a user is looking
 * at in the app is the side to keep.
 */
export function calendarEventIsNewer(
  eventUpdated: string | null | undefined,
  jobUpdatedAt: string | null | undefined
): boolean {
  if (!eventUpdated) return false;
  const event = Date.parse(eventUpdated);
  if (Number.isNaN(event)) return false;
  if (!jobUpdatedAt) return true; // no stamp on the row — the event is all we have
  const job = Date.parse(jobUpdatedAt);
  if (Number.isNaN(job)) return true;
  return event > job;
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
 *
 * DIRECTION MATTERS (item 1.8). This function writes to the jobs table, so it
 * can destroy work the office just did: before the guard below, an event the
 * calendar had not caught up with — because the push failed, was never made,
 * or a 410 forced a re-seed that re-listed every future event — was copied
 * straight back onto the job, silently undoing a drag with no user involved.
 *
 * It now only writes when the event is demonstrably the newer writer. When the
 * JOB is newer it pushes the job's times onto the event instead, so the two
 * converge in a single round rather than disagreeing forever. That patch bumps
 * `event.updated`, so the next poll sees the event as newer — and by then the
 * times match, so nothing is written and it does not oscillate.
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
  // Times the app's own edit won and was pushed back to Google instead.
  let pushedToCalendar = 0;
  // Pushes that failed. Counted and returned rather than swallowed: a job whose
  // event could not be corrected is still diverged, and the caller is the only
  // one able to say so.
  let pushFailed = 0;

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
      // `updated_at` is what makes the direction of a change knowable; without
      // it every comparison below degrades to "the times differ", which is the
      // bug this guard exists to close.
      const { data: job } = await supabase
        .from("jobs")
        .select("id, scheduled_start, scheduled_end, status, updated_at")
        .eq("google_event_id", event.id)
        .maybeSingle();
      if (!job) {
        skipped++;
        continue;
      }

      const eventWins = calendarEventIsNewer(event.updated, job.updated_at);

      if (event.status === "cancelled") {
        if (!eventWins) {
          // Someone deleted the event in Google, but the app touched this job
          // AFTER that. The event genuinely no longer exists, so the link has
          // to go — but clearing the schedule too would throw away the newer
          // edit, which is the whole failure this guard exists to prevent.
          // Re-creating the event needs the job number, title, customer and
          // site that only /sync-calendar assembles, so that stays its job.
          await supabase.from("jobs").update({ google_event_id: null }).eq("id", job.id);
          skipped++;
          continue;
        }
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

      if (!startChanged && !endChanged) continue;

      if (eventWins) {
        await supabase
          .from("jobs")
          .update({
            scheduled_start: newStart ? new Date(newStart).toISOString() : job.scheduled_start,
            scheduled_end: newEnd ? new Date(newEnd).toISOString() : job.scheduled_end,
          })
          .eq("id", job.id);
        updated++;
        continue;
      }

      // The JOB is the newer writer, so the event is stale. Correct the event
      // rather than the job — writing the job here is precisely the data loss
      // this guard exists to stop.
      if (!job.scheduled_start) {
        // The app cleared the schedule. Deleting the event is the right answer
        // but it is a destructive call, and /sync-calendar already owns that
        // decision (its `shouldRemove` branch). Leave it be and say so.
        skipped++;
        continue;
      }

      const pushStart = new Date(job.scheduled_start);
      // Same default as /sync-calendar (route.ts): a job with no end is an hour.
      const pushEnd = job.scheduled_end ? new Date(job.scheduled_end) : new Date(pushStart.getTime() + 60 * 60 * 1000);

      try {
        await calendar.events.patch({
          calendarId: "primary",
          eventId: event.id,
          requestBody: {
            start: { dateTime: pushStart.toISOString() },
            end: { dateTime: pushEnd.toISOString() },
          },
        });
        pushedToCalendar++;
      } catch (e: unknown) {
        const code = (e as { code?: number })?.code;
        if (code === 404 || code === 410) {
          // The event vanished between the list and the patch. Drop the dead
          // link; the schedule stays, and /sync-calendar recreates the event.
          await supabase.from("jobs").update({ google_event_id: null }).eq("id", job.id);
          skipped++;
          continue;
        }
        // One uncooperative event must not abort the reconciliation of every
        // other job, but nor may it vanish: it is counted and returned.
        console.error(`Calendar poll: could not push job ${job.id} onto event ${event.id}:`, e);
        pushFailed++;
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

  return { updated, clearedByDeletion, skipped, pushedToCalendar, pushFailed, initialSync: isInitialSync };
}
