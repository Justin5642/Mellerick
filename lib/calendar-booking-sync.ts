// Push one job's bookings to Google Calendar: one event PER BOOKING
// ("#2530 Rough-in — Dave"), agreed with Justin 19 Oct 2026. Called by
// /api/jobs/[id]/sync-calendar after every change to a job's schedule.
//
// job_bookings comes from migration 0079 yet.
// Until it is, syncJobCalendar reports `bookingsMissing` and the route keeps
// pushing the old single job-level event, so merging this before the apply
// changes nothing in anyone's calendar.
//
// WHAT A SYNC DOES (planBookingEventSync decides; syncJobCalendar does it):
//   * each booking's event is updated, or created and linked
//     (job_bookings.google_event_id);
//   * an event the app made for this job that no current booking links to is
//     deleted — found by its private extended property (EVENT_JOB_KEY), so a
//     booking deleted by any path, including the compatibility trigger that
//     rebuilds bookings on an old-style schedule write, does not leave a
//     stray event behind;
//   * the LEGACY job-level event (jobs.google_event_id, from before bookings)
//     is retired. When the job has exactly one booking it is ADOPTED instead:
//     rewritten as that booking's event and re-linked to it, so the common
//     one-technician job keeps the same event (and anything a person attached
//     to it in Google) rather than being deleted and recreated;
//   * a completed or cancelled job, or one with no bookings, has every event
//     removed — as the single event was before.
//
// WHY A LINK FAILURE NO LONGER MEANS "DO NOT RETRY". The single-event route
// had to refuse a retry when it created an event but could not record its id:
// the id was the only dedupe, and a retry made a duplicate. A booking event
// carries its booking id in EVENT_BOOKING_KEY, so the next sync finds it and
// re-links it (`relink`) instead of creating another.
import type { calendar_v3 } from "@googleapis/calendar";
import { buildBookingEventBody, EVENT_BOOKING_KEY, EVENT_JOB_KEY, type CalendarJob } from "./calendar-event";
import { BOOKING_COLUMNS, isBookingsTableMissing, type JobBooking } from "./bookings";

// ---------------------------------------------------------------------------
// Plan (pure)
// ---------------------------------------------------------------------------

export interface TaggedEvent {
  id: string;
  /** The booking id in the event's private EVENT_BOOKING_KEY, if any. */
  bookingId: string | null;
}

export type BookingEventAction =
  /** Update the event `eventId` with the booking's body (create if Google lost it), or create one when null. */
  | { kind: "upsert"; bookingId: string; eventId: string | null; relink: boolean }
  /** Rewrite the legacy job-level event as this booking's event and move the link onto the booking. */
  | { kind: "adopt"; bookingId: string; eventId: string }
  /** Delete an event. `unlinkBookingId` clears that booking's link after; `legacy` clears jobs.google_event_id. */
  | { kind: "delete"; eventId: string; unlinkBookingId: string | null; legacy: boolean };

export function planBookingEventSync(input: {
  /** Completed/cancelled: every event goes. */
  removeAll: boolean;
  /** jobs.google_event_id — the pre-bookings single event. */
  legacyEventId: string | null;
  bookings: readonly Pick<JobBooking, "id" | "google_event_id">[];
  /** Events in Google tagged with this job (EVENT_JOB_KEY). */
  taggedEvents: readonly TaggedEvent[];
}): BookingEventAction[] {
  const actions: BookingEventAction[] = [];
  const { legacyEventId, taggedEvents } = input;
  const bookings = input.removeAll ? [] : input.bookings;
  // Event ids that end up belonging to a current booking; every other event
  // this job owns is deleted.
  const kept = new Set<string>();

  // Removing: each linked booking event is deleted and the link cleared.
  if (input.removeAll) {
    for (const b of input.bookings) {
      if (!b.google_event_id) continue;
      actions.push({ kind: "delete", eventId: b.google_event_id, unlinkBookingId: b.id, legacy: false });
      kept.add(b.google_event_id); // handled; not deleted twice below
    }
  }

  const adopt =
    !!legacyEventId && bookings.length === 1 && !bookings[0].google_event_id
      ? bookings[0].id
      : null;

  for (const b of bookings) {
    if (b.id === adopt) {
      actions.push({ kind: "adopt", bookingId: b.id, eventId: legacyEventId! });
      kept.add(legacyEventId!);
      continue;
    }
    if (b.google_event_id) {
      actions.push({ kind: "upsert", bookingId: b.id, eventId: b.google_event_id, relink: false });
      kept.add(b.google_event_id);
      continue;
    }
    // Created earlier but never linked (the link write failed): re-link the
    // event that carries this booking's id rather than create a duplicate.
    const orphan = taggedEvents.find((e) => e.bookingId === b.id && !kept.has(e.id));
    if (orphan) {
      actions.push({ kind: "upsert", bookingId: b.id, eventId: orphan.id, relink: true });
      kept.add(orphan.id);
      continue;
    }
    actions.push({ kind: "upsert", bookingId: b.id, eventId: null, relink: true });
  }

  if (legacyEventId && !kept.has(legacyEventId)) {
    actions.push({ kind: "delete", eventId: legacyEventId, unlinkBookingId: null, legacy: true });
    kept.add(legacyEventId);
  }
  for (const e of taggedEvents) {
    if (kept.has(e.id)) continue;
    actions.push({ kind: "delete", eventId: e.id, unlinkBookingId: null, legacy: false });
    kept.add(e.id);
  }
  return actions;
}

// ---------------------------------------------------------------------------
// Do it
// ---------------------------------------------------------------------------

/** The slice of the Calendar client used here — narrow so a test can fake it. */
export type BookingSyncCalendar = {
  events: {
    list(params: calendar_v3.Params$Resource$Events$List): Promise<{ data: calendar_v3.Schema$Events }>;
    insert(params: calendar_v3.Params$Resource$Events$Insert): Promise<{ data: calendar_v3.Schema$Event }>;
    update(params: calendar_v3.Params$Resource$Events$Update): Promise<{ data: calendar_v3.Schema$Event }>;
    delete(params: calendar_v3.Params$Resource$Events$Delete): Promise<unknown>;
  };
};

export interface BookingSyncResult {
  /** job_bookings is not in this database (0079) — the caller falls back to the job-level event. */
  bookingsMissing?: boolean;
  notFound?: boolean;
  created: number;
  updated: number;
  adopted: number;
  deleted: number;
  /** Things that went wrong without failing the sync — each one is self-correcting on the next sync. */
  warnings: string[];
}

function isGone(e: unknown): boolean {
  const code = (e as { code?: number })?.code;
  return code === 404 || code === 410;
}

/** Up to three tries: a refused link write is worth one more go before it becomes a warning. */
async function withRetry(write: () => PromiseLike<{ error: { message: string } | null }>): Promise<string | null> {
  let message: string | null = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const { error } = await write();
    if (!error) return null;
    message = error.message;
    if (attempt < 3) await new Promise((r) => setTimeout(r, 150 * attempt));
  }
  return message;
}

/**
 * Sync one job's bookings to Google. `supabase` is the service-role client
 * the route authorised the caller for (it bypasses RLS, so the route checks
 * the job first). Throws on an unexpected Google error, as the single-event
 * route did; the route reports it.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the service-role client, as in lib/google.ts
export async function syncJobCalendar(supabase: any, calendar: BookingSyncCalendar, jobId: string): Promise<BookingSyncResult> {
  const result: BookingSyncResult = { created: 0, updated: 0, adopted: 0, deleted: 0, warnings: [] };

  const { data: bookingRows, error: bookingsError } = await supabase
    .from("job_bookings")
    .select(`${BOOKING_COLUMNS}, google_event_id`)
    .eq("job_id", jobId)
    .order("starts_at", { ascending: true });
  if (bookingsError) {
    if (isBookingsTableMissing(bookingsError)) return { ...result, bookingsMissing: true };
    throw new Error(`Could not read the job's bookings: ${bookingsError.message}`);
  }
  const bookings = (bookingRows ?? []) as JobBooking[];

  const { data: job } = await supabase
    .from("jobs")
    .select("id, job_number, title, description, status, google_event_id, customers(name), sites(address_line1, suburb, state, postcode)")
    .eq("id", jobId)
    .single();
  if (!job) return { ...result, notFound: true };

  // Names for the titles. po_cost_centers directly: this runs as the service
  // role, and only the name leaves the server.
  const staffIds = [...new Set(bookings.map((b) => b.staff_id).filter(Boolean))];
  const ccIds = [...new Set(bookings.map((b) => b.cost_center_id).filter(Boolean))];
  const [{ data: staffRows }, { data: ccRows }] = await Promise.all([
    staffIds.length > 0 ? supabase.from("profiles").select("id, full_name").in("id", staffIds) : { data: [] },
    ccIds.length > 0 ? supabase.from("po_cost_centers").select("id, name").in("id", ccIds) : { data: [] },
  ]);
  const staffNames = new Map<string, string>((staffRows ?? []).map((p: { id: string; full_name: string }) => [p.id, p.full_name]));
  const ccNames = new Map<string, string>((ccRows ?? []).map((c: { id: string; name: string }) => [c.id, c.name]));

  // Every event this job owns in Google, by tag. A failed listing must not
  // stop the bookings themselves syncing: it only means strays survive until
  // the next sync, so it is a warning.
  const taggedEvents: TaggedEvent[] = [];
  try {
    let pageToken: string | undefined;
    do {
      const res = await calendar.events.list({
        calendarId: "primary",
        privateExtendedProperty: [`${EVENT_JOB_KEY}=${jobId}`],
        showDeleted: false,
        maxResults: 250,
        pageToken,
      });
      for (const e of res.data.items ?? []) {
        if (!e.id || e.status === "cancelled") continue;
        taggedEvents.push({ id: e.id, bookingId: e.extendedProperties?.private?.[EVENT_BOOKING_KEY] ?? null });
      }
      pageToken = res.data.nextPageToken ?? undefined;
    } while (pageToken);
  } catch (e) {
    console.error(`Calendar sync: could not list job ${jobId}'s events:`, e);
    result.warnings.push("Could not check for stray calendar events; they will be cleaned up on the next sync.");
  }

  const actions = planBookingEventSync({
    removeAll: job.status === "cancelled" || job.status === "completed",
    legacyEventId: job.google_event_id ?? null,
    bookings,
    taggedEvents,
  });

  const byId = new Map(bookings.map((b) => [b.id, b]));
  const bodyFor = (bookingId: string) => {
    const b = byId.get(bookingId)!;
    return buildBookingEventBody(job as CalendarJob & { id: string }, b, {
      staffName: b.staff_id ? staffNames.get(b.staff_id) ?? null : null,
      costCenterName: b.cost_center_id ? ccNames.get(b.cost_center_id) ?? null : null,
    })!;
  };
  const link = async (bookingId: string, eventId: string) => {
    const failed = await withRetry(() => supabase.from("job_bookings").update({ google_event_id: eventId }).eq("id", bookingId));
    if (failed) {
      // The event is tagged with this booking, so the next sync re-links it
      // instead of creating a second one.
      console.error(`Calendar sync: event ${eventId} created but not linked to booking ${bookingId}:`, failed);
      result.warnings.push("A calendar event was created but not linked yet; the next sync links it.");
    }
  };
  const clearLegacyLink = async () => {
    const failed = await withRetry(() => supabase.from("jobs").update({ google_event_id: null }).eq("id", jobId));
    if (failed) {
      // Left set, the next sync tries the (already gone) legacy event again,
      // takes its 404 and clears it then — self-correcting, so a warning.
      console.error(`Calendar sync: legacy event retired but job ${jobId} still references it:`, failed);
      result.warnings.push("The job still references its old calendar event; the next sync clears it.");
    }
  };
  const insert = async (bookingId: string) => {
    const res = await calendar.events.insert({ calendarId: "primary", requestBody: bodyFor(bookingId) });
    result.created++;
    return res.data.id!;
  };

  for (const action of actions) {
    if (action.kind === "delete") {
      try {
        await calendar.events.delete({ calendarId: "primary", eventId: action.eventId });
        result.deleted++;
      } catch (e) {
        if (!isGone(e)) throw e;
      }
      if (action.legacy) await clearLegacyLink();
      if (action.unlinkBookingId) {
        const failed = await withRetry(() =>
          supabase.from("job_bookings").update({ google_event_id: null }).eq("id", action.unlinkBookingId),
        );
        if (failed) result.warnings.push("A removed calendar event is still linked to its booking.");
      }
      continue;
    }

    // upsert / adopt: update the event in place, or create it when there is
    // none (or Google no longer has it).
    let eventId = action.eventId;
    if (eventId) {
      try {
        await calendar.events.update({ calendarId: "primary", eventId, requestBody: bodyFor(action.bookingId) });
        if (action.kind === "adopt") result.adopted++;
        else result.updated++;
      } catch (e) {
        if (!isGone(e)) throw e;
        eventId = null;
      }
    }
    const created = !eventId;
    if (!eventId) eventId = await insert(action.bookingId);
    if (created || action.kind === "adopt" || (action.kind === "upsert" && action.relink)) {
      await link(action.bookingId, eventId);
    }
    if (action.kind === "adopt") await clearLegacyLink();
  }

  return result;
}
