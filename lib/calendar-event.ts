// Pure job → Google Calendar event mapping. No I/O: the push route
// (app/api/jobs/[id]/sync-calendar) and the poll (lib/google.ts) both build
// the event's timing here, so "what the calendar should say about this job"
// has one answer.
//
// A single-window job (schedule_daily false) is one event from
// scheduled_start to scheduled_end, exactly as before migration 0071.
//
// A multi-day job (schedule_daily true) is ONE recurring event: the first
// booked day's block, in Melbourne wall time with timeZone set (so Google
// keeps 07:00 at 07:00 across a DST change), repeated daily until the last
// booked day, with an EXDATE for every day in between that is not booked
// (the weekends scheduleDays() skips). RRULE+EXDATE rather than RDATE because
// RDATE support in Google Calendar is patchy (the UI cannot edit it), while
// DAILY/UNTIL/EXDATE is what Google itself writes. The occurrences equal
// scheduleDays(job) exactly — tests/unit/calendar-event.test.ts expands the
// rule and compares.
import { BUSINESS_TIME_ZONE, fromBusinessInputValue, shiftDateKey, toBusinessInputValue } from "./date";
import { scheduleDays, type ScheduledJobWindow, type ScheduleDay } from "./scheduling";

export interface CalendarEventDateTime {
  dateTime: string;
  timeZone?: string;
}

export interface CalendarEventTiming {
  start: CalendarEventDateTime;
  end: CalendarEventDateTime;
  /** [] for a single event — sent explicitly so an update from daily → single clears the series. */
  recurrence: string[];
}

export interface CalendarJob extends ScheduledJobWindow {
  job_number?: number | string | null;
  title?: string | null;
  description?: string | null;
  customers?: { name?: string | null } | null;
  sites?: {
    address_line1?: string | null;
    suburb?: string | null;
    state?: string | null;
    postcode?: string | null;
  } | null;
}

const ONE_HOUR_MS = 60 * 60 * 1000;

/** "2026-10-02T07:00:00" — Melbourne wall time, for a dateTime paired with timeZone. */
function melbourneWallTime(iso: string): string {
  return `${toBusinessInputValue(iso)}:00`;
}

/** "20261002T070000" — Melbourne wall time in RFC 5545 basic form (for TZID= values). */
function basicLocal(iso: string): string {
  return melbourneWallTime(iso).replace(/[-:]/g, "");
}

/** "20261005T200000Z" — UTC in RFC 5545 basic form (UNTIL must be UTC when DTSTART has a TZID). */
function basicUtc(iso: string): string {
  return new Date(iso).toISOString().replace(/\.\d{3}Z$/, "Z").replace(/[-:]/g, "");
}

/** The days one series must exist on, ie scheduleDays() for a daily job, or null when it is not one. */
function dailyDays(job: ScheduledJobWindow): ScheduleDay[] | null {
  if (!job.schedule_daily || !job.scheduled_start) return null;
  const days = scheduleDays(job);
  return days.length > 0 ? days : null;
}

/** The event's start/end/recurrence for a job, or null when the job is unscheduled. */
export function buildCalendarEventTiming(job: ScheduledJobWindow): CalendarEventTiming | null {
  if (!job.scheduled_start) return null;

  const days = dailyDays(job);
  if (!days) {
    // Unchanged from before 0071: one block, a missing end is an hour.
    const start = new Date(job.scheduled_start);
    const end = job.scheduled_end ? new Date(job.scheduled_end) : new Date(start.getTime() + ONE_HOUR_MS);
    return { start: { dateTime: start.toISOString() }, end: { dateTime: end.toISOString() }, recurrence: [] };
  }

  const first = days[0];
  const last = days[days.length - 1];
  const timing: CalendarEventTiming = {
    start: { dateTime: melbourneWallTime(first.startIso), timeZone: BUSINESS_TIME_ZONE },
    end: { dateTime: melbourneWallTime(first.endIso), timeZone: BUSINESS_TIME_ZONE },
    recurrence: [],
  };
  if (days.length === 1) return timing;

  const booked = new Set(days.map((d) => d.dateKey));
  const startTime = basicLocal(first.startIso).slice(8); // "T070000"
  const skipped: string[] = [];
  for (let key = shiftDateKey(first.dateKey, 1); key < last.dateKey; key = shiftDateKey(key, 1)) {
    if (!booked.has(key)) skipped.push(`${key.replace(/-/g, "")}${startTime}`);
  }

  // UNTIL is the last occurrence's own start, so it is inclusive by
  // construction and the next day's occurrence is always past it.
  timing.recurrence.push(`RRULE:FREQ=DAILY;UNTIL=${basicUtc(last.startIso)}`);
  if (skipped.length > 0) timing.recurrence.push(`EXDATE;TZID=${BUSINESS_TIME_ZONE}:${skipped.join(",")}`);
  return timing;
}

/** The full event body the push route sends (insert or full update). Null when unscheduled. */
export function buildCalendarEventBody(job: CalendarJob) {
  const timing = buildCalendarEventTiming(job);
  if (!timing) return null;
  const site = job.sites;
  const location = site
    ? [site.address_line1, site.suburb, site.state, site.postcode].filter(Boolean).join(", ")
    : undefined;
  return {
    summary: `#${job.job_number} — ${job.title}`,
    description: [job.description, job.customers?.name ? `Customer: ${job.customers.name}` : null]
      .filter(Boolean)
      .join("\n\n"),
    location,
    ...timing,
  };
}

// ---------------------------------------------------------------------------
// One event per BOOKING
// ---------------------------------------------------------------------------
// With job_bookings (migration 0079 — a draft, not applied yet) each booking
// is its own event: "#2530 Rough-in — Dave". The timing rules are the job's,
// unchanged — a booking's window means what a job's did — so the booking is
// handed to buildCalendarEventTiming in the job-shaped form.
//
// Every booking event carries private extended properties naming its job and
// booking. They are what lets a sync find events the app made but no longer
// links to — a booking deleted by an old-style schedule write (the
// compatibility trigger rebuilds bookings, dropping their google_event_id),
// or an insert whose link write failed — and delete or re-link them instead
// of leaving a stray event in someone's calendar for ever.

/** Private extended-property keys on every booking event. */
export const EVENT_JOB_KEY = "mellerickJobId";
export const EVENT_BOOKING_KEY = "mellerickBookingId";

export interface CalendarBooking {
  id: string;
  starts_at: string;
  ends_at: string | null;
  daily: boolean;
  all_day?: boolean;
}

/**
 * "#2530 Rough-in — Dave". The cost centre names the stage; with none, the
 * job title stands in ("#2530 Hot water service — Dave"). No technician:
 * "Unassigned", so the office can see the gap in the calendar too.
 */
export function bookingEventSummary(
  job: Pick<CalendarJob, "job_number" | "title">,
  costCenterName: string | null | undefined,
  staffName: string | null | undefined,
): string {
  const what = costCenterName?.trim() || job.title?.trim() || "Job";
  return `#${job.job_number} ${what} — ${staffName?.trim() || "Unassigned"}`;
}

/** The full event body for one booking. Null only for a booking without a start, which the table forbids. */
export function buildBookingEventBody(
  job: CalendarJob & { id: string },
  booking: CalendarBooking,
  names: { staffName?: string | null; costCenterName?: string | null },
) {
  const base = buildCalendarEventBody({
    ...job,
    scheduled_start: booking.starts_at,
    scheduled_end: booking.ends_at,
    schedule_daily: booking.daily,
  });
  if (!base) return null;
  return {
    ...base,
    summary: bookingEventSummary(job, names.costCenterName, names.staffName),
    extendedProperties: { private: { [EVENT_JOB_KEY]: job.id, [EVENT_BOOKING_KEY]: booking.id } },
  };
}

// ---------------------------------------------------------------------------
// Reading an event back (poll)
// ---------------------------------------------------------------------------

export interface CalendarEventLike {
  status?: string | null;
  start?: { dateTime?: string | null; date?: string | null } | null;
  end?: { dateTime?: string | null; date?: string | null } | null;
  originalStartTime?: { dateTime?: string | null; date?: string | null } | null;
  recurrence?: string[] | null;
}

function instant(value: string | null | undefined): number | null {
  if (!value) return null;
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : t;
}

/** The instant of a timing's start/end (a daily timing is Melbourne wall time + timeZone). */
function timingInstant(dt: CalendarEventDateTime): number {
  return Date.parse(dt.timeZone ? fromBusinessInputValue(dt.dateTime.slice(0, 16)) : dt.dateTime);
}

/** Order-insensitive form of a recurrence list, so Google's own reformatting is not a "change". */
function normaliseRecurrence(lines: string[] | null | undefined): string {
  return (lines ?? [])
    .map((line) => {
      const compact = line.replace(/\s+/g, "").toUpperCase();
      const colon = compact.indexOf(":");
      if (colon < 0) return compact;
      const head = compact.slice(0, colon);
      const value = compact.slice(colon + 1);
      if (head === "RRULE") return `${head}:${value.split(";").filter(Boolean).sort().join(";")}`;
      return `${head}:${value.split(",").sort().join(",")}`;
    })
    .sort()
    .join("\n");
}

/**
 * Whether a (master or single) event already says what the job says: same
 * first block, same recurrence. All-day events never match a job (jobs are
 * always timed).
 */
export function eventMatchesJob(event: CalendarEventLike, job: ScheduledJobWindow): boolean {
  const timing = buildCalendarEventTiming(job);
  if (!timing) return false;
  return (
    instant(event.start?.dateTime) === timingInstant(timing.start) &&
    instant(event.end?.dateTime) === timingInstant(timing.end) &&
    normaliseRecurrence(event.recurrence) === normaliseRecurrence(timing.recurrence)
  );
}

/**
 * Whether one occurrence of a daily job's series (singleEvents: true) is
 * exactly the block scheduleDays() says it should be. False for a cancelled
 * or moved occurrence, or one that is not a booked day at all.
 */
export function instanceMatchesJob(instance: CalendarEventLike, job: ScheduledJobWindow): boolean {
  if (instance.status === "cancelled") return false;
  const original = instant(instance.originalStartTime?.dateTime ?? instance.start?.dateTime);
  const day = scheduleDays(job).find((d) => Date.parse(d.startIso) === original);
  if (!day) return false;
  return (
    instant(instance.start?.dateTime) === Date.parse(day.startIso) &&
    instant(instance.end?.dateTime) === Date.parse(day.endIso)
  );
}
