// The per-API packages, not the 200 MB `googleapis` umbrella — this app only
// uses Calendar (here) and OAuth2 userinfo (app/api/google/callback).
import { auth, calendar, type calendar_v3 } from "@googleapis/calendar";
import { createClient } from "@/lib/supabase/server";
import { buildCalendarEventTiming, eventMatchesJob, instanceMatchesJob } from "@/lib/calendar-event";
import { shiftDateKey } from "@/lib/date";
import {
  buildScheduleColumns,
  DEFAULT_SHIFT_END_TIME,
  DEFAULT_SHIFT_START_TIME,
  type ScheduleColumns,
} from "@/lib/scheduling";
import { createAdminClient } from "@/lib/supabase/admin";
// The OAuth token tables are read and written ONLY through the service role.
// Migration 0075 revokes the token columns from every signed-in user, so an
// office account or an XSS on the dashboard cannot lift the refresh token.
// Every caller of this module is already authorised by its route — admin,
// office/admin, a job-scoped check, or the cron secret — so this is a read of
// the org's single connection on behalf of someone allowed to use it. The
// client a caller passes in is still used for everything else (jobs,
// invoices), so those writes keep running under the caller's own RLS.
function tokenClient() {
  return createAdminClient();
}


const SCOPES = [
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/userinfo.email",
];

export function getGoogleOAuthClient() {
  return new auth.OAuth2(
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
  const { data: tokenRow } = await tokenClient().from("google_tokens").select("*").single();
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
    // Discarded, a refused write here means the refreshed token is never
    // stored, so EVERY later call refreshes again — and Google may rotate the
    // refresh token while doing so, in which case the one still in the database
    // is already dead and the connection is gone until someone reconnects by
    // hand. Throwing is right: the caller otherwise holds a token that works
    // for this call and nothing after it, which is worse than a clear failure.
    const { error: persistError } = await tokenClient()
      .from("google_tokens")
      .update({
        access_token: credentials.access_token!,
        token_expiry: new Date(credentials.expiry_date!).toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", tokenRow.id);
    if (persistError) {
      throw new Error(
        `Google token refreshed but could not be saved (${persistError.message}). ` +
          `Calendar sync would keep re-refreshing and may lose the connection.`
      );
    }
  }

  return calendar({ version: "v3", auth: oauth2Client });
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

type CalendarEvent = calendar_v3.Schema$Event;

type PolledJob = {
  id: string;
  scheduled_start: string | null;
  scheduled_end: string | null;
  schedule_daily: boolean | null;
  schedule_all_day: boolean | null;
  status: string;
  updated_at: string | null;
};

/**
 * What an event says the job's columns should be, when the event is the newer
 * writer. A timed event is its own start/end. An ALL-DAY event (start.date,
 * end.date exclusive) is the standard shift on each of its dates — the same
 * columns the Schedule Job dialog writes with "All day" ticked — rather than a
 * UTC-midnight 24 h block nobody meant.
 */
function columnsFromEvent(event: {
  start?: { dateTime?: string | null; date?: string | null } | null;
  end?: { dateTime?: string | null; date?: string | null } | null;
}): Partial<ScheduleColumns> | null {
  if (!event.start?.dateTime && event.start?.date) {
    const startDateKey = event.start.date;
    const endExclusive = event.end?.date ?? shiftDateKey(startDateKey, 1);
    const lastKey = shiftDateKey(endExclusive, -1);
    return buildScheduleColumns({
      startDateKey,
      endDateKey: lastKey < startDateKey ? startDateKey : lastKey,
      startTime: DEFAULT_SHIFT_START_TIME,
      endTime: DEFAULT_SHIFT_END_TIME,
      allDay: true,
    });
  }
  const start = event.start?.dateTime ?? null;
  const end = event.end?.dateTime ?? null;
  if (!start && !end) return null;
  const cols: Partial<ScheduleColumns> = {};
  if (start) cols.scheduled_start = new Date(start).toISOString();
  if (end) cols.scheduled_end = new Date(end).toISOString();
  return cols;
}

function sameInstant(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return !a && !b;
  return new Date(a).getTime() === new Date(b).getTime();
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
 *
 * MULTI-DAY JOBS (schedule_daily, migration 0071) are ONE recurring event (see
 * lib/calendar-event.ts). The listing uses singleEvents: true, so a series
 * arrives as its occurrences — each with its own id and `recurringEventId` =
 * the master, which is what jobs.google_event_id holds. For those the app is
 * the source of truth:
 *   - one occurrence edited or deleted in Google is NEVER written back (it
 *     would collapse the whole schedule into that one day) — logged, counted
 *     in `seriesSkipped`;
 *   - the series itself deleted → the ordinary deletion path;
 *   - the series itself changed: job newer → the job is pushed back onto the
 *     master; event newer → logged and skipped, because reverse-engineering a
 *     recurrence rule into "start date, end date, daily hours" is guesswork.
 */
export async function pollGoogleCalendarChanges(supabase: any) {
  const { data: tokenRow } = await tokenClient().from("google_tokens").select("*").single();
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
  // Dead google_event_id links that could not be cleared.
  let linkClearFailed = 0;
  // Job or token writes the database refused. Returned rather than swallowed:
  // every other count here describes what the poll INTENDED, and only this says
  // what actually landed.
  let writeFailed = 0;
  // Google-side edits to a recurring (multi-day) job's event that were
  // deliberately NOT written back — the app owns multi-day schedules.
  let seriesSkipped = 0;

  // If we don't have a sync token yet, scope the initial listing to "from
  // now on" so we don't walk years of calendar history on the first run.
  const isInitialSync = !syncToken;

  // A series' occurrences arrive together; fetch each master once and
  // reconcile each series once per poll.
  const masters = new Map<string, CalendarEvent | null>();
  const reconciledSeries = new Set<string>();

  // `updated_at` is what makes the direction of a change knowable; without
  // it every comparison below degrades to "the times differ", which is the
  // bug this guard exists to close.
  const findJob = async (eventId: string): Promise<PolledJob | null> => {
    const { data } = await supabase
      .from("jobs")
      .select("id, scheduled_start, scheduled_end, schedule_daily, schedule_all_day, status, updated_at")
      .eq("google_event_id", eventId)
      .maybeSingle();
    return data ?? null;
  };

  const dropLink = async (jobId: string) => {
    const { error: linkError } = await supabase.from("jobs").update({ google_event_id: null }).eq("id", jobId);
    // Left set, the job keeps pointing at an event that no longer exists,
    // so /sync-calendar takes its UPDATE branch, 404s, and recreates —
    // producing a duplicate rather than repairing the link.
    if (linkError) linkClearFailed++;
  };

  /** The event (or whole series) is gone from Google. */
  const handleDeletion = async (job: PolledJob, eventUpdated: string | null | undefined) => {
    if (!calendarEventIsNewer(eventUpdated, job.updated_at)) {
      // Someone deleted the event in Google, but the app touched this job
      // AFTER that. The event genuinely no longer exists, so the link has
      // to go — but clearing the schedule too would throw away the newer
      // edit, which is the whole failure this guard exists to prevent.
      // Re-creating the event needs the job number, title, customer and
      // site that only /sync-calendar assembles, so that stays its job.
      await dropLink(job.id);
      skipped++;
      return;
    }
    // Event was deleted directly in Google Calendar — clear the schedule so
    // office staff notice the job needs re-booking, rather than silently
    // leaving a stale schedule in place. The 0071 flags go with it: an
    // unscheduled job is neither multi-day nor all-day.
    const cleared = await supabase
      .from("jobs")
      .update({
        scheduled_start: null,
        scheduled_end: null,
        schedule_daily: false,
        schedule_all_day: false,
        google_event_id: null,
      })
      .eq("id", job.id);
    // Counting this regardless would report a re-booking prompt the office
    // never actually gets.
    if (cleared.error) {
      console.error(`Calendar poll: could not clear job ${job.id}:`, cleared.error.message);
      writeFailed++;
    } else clearedByDeletion++;
  };

  /** The JOB is newer: correct the event (a single event or a series master). */
  const pushJobOntoEvent = async (job: PolledJob, eventId: string) => {
    const timing = buildCalendarEventTiming(job);
    if (!timing) {
      // The app cleared the schedule. Deleting the event is the right answer
      // but it is a destructive call, and /sync-calendar already owns that
      // decision (its `shouldRemove` branch). Leave it be and say so.
      skipped++;
      return;
    }
    try {
      await calendar.events.patch({
        calendarId: "primary",
        eventId,
        requestBody: {
          // `date: null` so a patch onto an all-day event does not leave it
          // holding both a date and a dateTime, which Google rejects.
          start: { ...timing.start, date: null },
          end: { ...timing.end, date: null },
          recurrence: timing.recurrence,
        },
      });
      pushedToCalendar++;
    } catch (e: unknown) {
      const code = (e as { code?: number })?.code;
      if (code === 404 || code === 410) {
        // The event vanished between the list and the patch. Drop the dead
        // link; the schedule stays, and /sync-calendar recreates the event.
        await dropLink(job.id);
        skipped++;
        return;
      }
      // One uncooperative event must not abort the reconciliation of every
      // other job, but nor may it vanish: it is counted and returned.
      console.error(`Calendar poll: could not push job ${job.id} onto event ${eventId}:`, e);
      pushFailed++;
    }
  };

  /** Fetch a series master once per poll. null = gone (404/410). Throws on anything else. */
  const getMaster = async (masterId: string): Promise<CalendarEvent | null> => {
    if (masters.has(masterId)) return masters.get(masterId) ?? null;
    let master: CalendarEvent | null;
    try {
      master = (await calendar.events.get({ calendarId: "primary", eventId: masterId })).data ?? null;
    } catch (e: unknown) {
      const code = (e as { code?: number })?.code;
      if (code !== 404 && code !== 410) throw e;
      master = null;
    }
    masters.set(masterId, master);
    return master;
  };

  /**
   * An event belonging to a recurring series, or any event of a multi-day
   * job. `masterId` is the job's google_event_id.
   */
  const handleSeriesEvent = async (event: CalendarEvent, job: PolledJob, masterId: string) => {
    const isOccurrence = event.id !== masterId;
    let master: CalendarEvent | null;
    if (isOccurrence) {
      try {
        master = await getMaster(masterId);
      } catch (e) {
        console.error(`Calendar poll: could not read series ${masterId} for job ${job.id}:`, e);
        skipped++;
        return;
      }
    } else {
      master = event;
    }

    if (!master || master.status === "cancelled") {
      if (reconciledSeries.has(masterId)) return;
      reconciledSeries.add(masterId);
      await handleDeletion(job, master?.updated ?? event.updated);
      return;
    }

    if (!eventMatchesJob(master, job)) {
      // The series itself disagrees with the job.
      if (reconciledSeries.has(masterId)) return;
      reconciledSeries.add(masterId);
      if (calendarEventIsNewer(master.updated, job.updated_at)) {
        console.warn(
          `Calendar poll: event ${masterId} for job ${job.id} was changed in Google; ` +
            `not written back — the app is the source of truth for multi-day schedules.`
        );
        seriesSkipped++;
        return;
      }
      await pushJobOntoEvent(job, masterId);
      return;
    }

    // The series matches the job. An occurrence that is not its booked block
    // was edited or deleted on its own in Google; writing it onto the job
    // would turn the whole schedule into that one day.
    if (isOccurrence && !instanceMatchesJob(event, job)) {
      console.warn(
        `Calendar poll: one occurrence (${event.id}) of job ${job.id}'s calendar series was ` +
          `${event.status === "cancelled" ? "deleted" : "edited"} in Google; not written back.`
      );
      seriesSkipped++;
    }
  };

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
        // If THIS write is refused the stored token stays dead, every later
        // run takes the same 410, and calendar sync stops permanently while
        // reporting `resyncRequired` each time as though it were recovering.
        const { error: clearError } = await tokenClient()
          .from("google_tokens")
          .update({ calendar_sync_token: null })
          .eq("id", tokenRow.id);
        if (clearError) {
          throw new Error(
            `Google calendar sync token is stale and could not be cleared (${clearError.message}). ` +
              `Sync will keep failing until it is reset.`
          );
        }
        return { resyncRequired: true };
      }
      throw e;
    }

    for (const event of res.data.items ?? []) {
      if (!event.id) continue;

      // An occurrence of a series is linked through its master's id.
      let job = await findJob(event.id);
      let masterId = event.id;
      if (!job && event.recurringEventId) {
        job = await findJob(event.recurringEventId);
        masterId = event.recurringEventId;
      }
      if (!job) {
        skipped++;
        continue;
      }

      if (masterId !== event.id || job.schedule_daily || (event.recurrence?.length ?? 0) > 0) {
        await handleSeriesEvent(event, job, masterId);
        continue;
      }

      if (event.status === "cancelled") {
        await handleDeletion(job, event.updated);
        continue;
      }

      const fromEvent = columnsFromEvent(event);
      if (!fromEvent) continue;
      const changed =
        (fromEvent.scheduled_start !== undefined && !sameInstant(fromEvent.scheduled_start, job.scheduled_start)) ||
        (fromEvent.scheduled_end !== undefined && !sameInstant(fromEvent.scheduled_end, job.scheduled_end)) ||
        (fromEvent.schedule_daily !== undefined && fromEvent.schedule_daily !== !!job.schedule_daily);

      if (!changed) continue;

      if (calendarEventIsNewer(event.updated, job.updated_at)) {
        // THE write this whole function exists to make — and `updated++` ran
        // whether or not it landed, so the poll could report "3 jobs updated"
        // having changed none of them.
        const applied = await supabase.from("jobs").update(fromEvent).eq("id", job.id);
        if (applied.error) {
          console.error(`Calendar poll: could not apply event to job ${job.id}:`, applied.error.message);
          writeFailed++;
          continue;
        }
        updated++;
        continue;
      }

      // The JOB is the newer writer, so the event is stale. Correct the event
      // rather than the job — writing the job here is precisely the data loss
      // this guard exists to stop.
      await pushJobOntoEvent(job, event.id);
    }

    pageToken = res.data.nextPageToken ?? undefined;
    if (res.data.nextSyncToken) nextSyncToken = res.data.nextSyncToken;
  } while (pageToken);

  // The same watermark rule as the Xero reconciler. This token is what stops
  // the next run re-reading the same window, so a refused write means every
  // later poll re-processes from the same point — forever, while reporting
  // success each time.
  const { error: tokenError } = await tokenClient()
    .from("google_tokens")
    .update({
      calendar_sync_token: nextSyncToken ?? syncToken ?? null,
      calendar_last_synced_at: new Date().toISOString(),
    })
    .eq("id", tokenRow.id);
  if (tokenError) {
    console.error("Calendar poll: could not store the sync token:", tokenError.message);
    writeFailed++;
  }

  return {
    updated,
    clearedByDeletion,
    skipped,
    pushedToCalendar,
    pushFailed,
    linkClearFailed,
    writeFailed,
    seriesSkipped,
    initialSync: isInitialSync,
  };
}
