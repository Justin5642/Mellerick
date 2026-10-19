import { describe, it, expect, vi } from "vitest";
import { planBookingEventSync, syncJobCalendar, type BookingSyncCalendar } from "@/lib/calendar-booking-sync";
import { bookingEventSummary, buildBookingEventBody, EVENT_BOOKING_KEY, EVENT_JOB_KEY } from "@/lib/calendar-event";

// ============================================================================
// One Google Calendar event PER BOOKING (Justin, 19 Oct 2026), replacing the
// one event per job. job_bookings is from 0079 — a draft, not applied yet.
//
// What must hold:
//   * each booking has exactly one event, updated in place once it exists;
//   * an event for a booking that no longer exists is deleted — including
//     one whose booking vanished WITHOUT the sync seeing it go (the
//     compatibility trigger rebuilds bookings on an old-style schedule
//     write), found by the job tag every booking event carries;
//   * the legacy job-level event is retired — adopted by the job's only
//     booking when there is exactly one, deleted otherwise;
//   * a created-but-unlinked event is re-linked, never duplicated.
// ============================================================================

describe("bookingEventSummary", () => {
  it("is '#<job> <cost centre> — <technician>'", () => {
    expect(bookingEventSummary({ job_number: 2530, title: "Kitchen reno" }, "Rough-in", "Dave")).toBe("#2530 Rough-in — Dave");
  });

  it("falls back to the job title without a cost centre, and to Unassigned without a technician", () => {
    expect(bookingEventSummary({ job_number: 2530, title: "Kitchen reno" }, null, null)).toBe("#2530 Kitchen reno — Unassigned");
  });

  it("tags the event with its job and booking", () => {
    const body = buildBookingEventBody(
      { id: "job-1", job_number: 2530, title: "Kitchen reno", scheduled_start: null, scheduled_end: null },
      { id: "bk-1", starts_at: "2026-10-19T20:00:00.000Z", ends_at: "2026-10-20T04:30:00.000Z", daily: false },
      { staffName: "Dave", costCenterName: "Rough-in" },
    );
    expect(body).toMatchObject({
      summary: "#2530 Rough-in — Dave",
      start: { dateTime: "2026-10-19T20:00:00.000Z" },
      extendedProperties: { private: { [EVENT_JOB_KEY]: "job-1", [EVENT_BOOKING_KEY]: "bk-1" } },
    });
  });
});

describe("planBookingEventSync", () => {
  it("creates an event for a new booking and updates a linked one", () => {
    const actions = planBookingEventSync({
      removeAll: false,
      legacyEventId: null,
      bookings: [
        { id: "bk-1", google_event_id: "ev-1" },
        { id: "bk-2", google_event_id: null },
      ],
      taggedEvents: [{ id: "ev-1", bookingId: "bk-1" }],
    });
    expect(actions).toEqual([
      { kind: "upsert", bookingId: "bk-1", eventId: "ev-1", relink: false },
      { kind: "upsert", bookingId: "bk-2", eventId: null, relink: true },
    ]);
  });

  it("deletes a tagged event no current booking links to (a booking removed by any path)", () => {
    const actions = planBookingEventSync({
      removeAll: false,
      legacyEventId: null,
      bookings: [{ id: "bk-1", google_event_id: "ev-1" }],
      taggedEvents: [
        { id: "ev-1", bookingId: "bk-1" },
        { id: "ev-gone", bookingId: "bk-deleted" },
      ],
    });
    expect(actions).toContainEqual({ kind: "delete", eventId: "ev-gone", unlinkBookingId: null, legacy: false });
  });

  it("re-links an event created for a booking whose link write failed, instead of duplicating it", () => {
    const actions = planBookingEventSync({
      removeAll: false,
      legacyEventId: null,
      bookings: [{ id: "bk-1", google_event_id: null }],
      taggedEvents: [{ id: "ev-made", bookingId: "bk-1" }],
    });
    expect(actions).toEqual([{ kind: "upsert", bookingId: "bk-1", eventId: "ev-made", relink: true }]);
  });

  it("the job's only booking ADOPTS the legacy job event", () => {
    const actions = planBookingEventSync({
      removeAll: false,
      legacyEventId: "ev-legacy",
      bookings: [{ id: "bk-1", google_event_id: null }],
      taggedEvents: [],
    });
    expect(actions).toEqual([{ kind: "adopt", bookingId: "bk-1", eventId: "ev-legacy" }]);
  });

  it("with several bookings the legacy event is deleted and each booking gets its own", () => {
    const actions = planBookingEventSync({
      removeAll: false,
      legacyEventId: "ev-legacy",
      bookings: [
        { id: "bk-1", google_event_id: null },
        { id: "bk-2", google_event_id: null },
      ],
      taggedEvents: [],
    });
    expect(actions.filter((a) => a.kind === "upsert")).toHaveLength(2);
    expect(actions).toContainEqual({ kind: "delete", eventId: "ev-legacy", unlinkBookingId: null, legacy: true });
  });

  it("a completed/cancelled job loses every event and every link", () => {
    const actions = planBookingEventSync({
      removeAll: true,
      legacyEventId: "ev-legacy",
      bookings: [{ id: "bk-1", google_event_id: "ev-1" }],
      taggedEvents: [
        { id: "ev-1", bookingId: "bk-1" },
        { id: "ev-stray", bookingId: null },
      ],
    });
    expect(actions).toEqual([
      { kind: "delete", eventId: "ev-1", unlinkBookingId: "bk-1", legacy: false },
      { kind: "delete", eventId: "ev-legacy", unlinkBookingId: null, legacy: true },
      { kind: "delete", eventId: "ev-stray", unlinkBookingId: null, legacy: false },
    ]);
  });
});

// ---------------------------------------------------------------------------
// The executor, against a fake Supabase and a fake Calendar.
// ---------------------------------------------------------------------------

function fakeSupabase(state: { bookings: Array<Record<string, unknown>>; job: Record<string, unknown> }) {
  const writes: Array<{ table: string; id: string; payload: Record<string, unknown> }> = [];
  const from = (table: string) => {
    let payload: Record<string, unknown> | null = null;
    let id = "";
    const api: Record<string, unknown> = {
      select: () => api,
      order: () => api,
      in: () => api,
      update: (p: Record<string, unknown>) => {
        payload = p;
        return api;
      },
      eq: (_c: string, v: string) => {
        id = v;
        return api;
      },
      single: async () => ({ data: table === "jobs" ? state.job : null, error: null }),
      then: (ok: (v: unknown) => unknown) => {
        if (payload) {
          writes.push({ table, id, payload });
          return Promise.resolve({ data: null, error: null }).then(ok);
        }
        const data =
          table === "job_bookings" ? state.bookings
          : table === "profiles" ? [{ id: "dave", full_name: "Dave" }]
          : table === "po_cost_centers" ? [{ id: "cc-rough", name: "Rough-in" }]
          : null;
        return Promise.resolve({ data, error: null }).then(ok);
      },
    };
    return api;
  };
  return { supabase: { from }, writes };
}

function fakeCalendar(tagged: Array<{ id: string; bookingId: string | null }> = []) {
  let next = 1;
  const calendar = {
    events: {
      list: vi.fn(async () => ({
        data: { items: tagged.map((t) => ({ id: t.id, extendedProperties: { private: { [EVENT_BOOKING_KEY]: t.bookingId ?? undefined } } })) },
      })),
      insert: vi.fn(async () => ({ data: { id: `ev-new-${next++}` } })),
      update: vi.fn(async (p: { eventId: string }) => ({ data: { id: p.eventId } })),
      delete: vi.fn(async () => ({})),
    },
  };
  return calendar as typeof calendar & BookingSyncCalendar;
}

const JOB = { id: "job-1", job_number: 2530, title: "Kitchen reno", status: "scheduled", google_event_id: null };
const BOOKING = {
  id: "bk-1",
  job_id: "job-1",
  staff_id: "dave",
  cost_center_id: "cc-rough",
  starts_at: "2026-10-19T20:00:00.000Z",
  ends_at: "2026-10-20T04:30:00.000Z",
  daily: false,
  all_day: false,
  google_event_id: null,
};

describe("syncJobCalendar", () => {
  it("creates a titled event for a new booking and links it to the booking", async () => {
    const { supabase, writes } = fakeSupabase({ bookings: [BOOKING], job: JOB });
    const calendar = fakeCalendar();

    const result = await syncJobCalendar(supabase, calendar, "job-1");

    expect(calendar.events.insert).toHaveBeenCalledTimes(1);
    expect(calendar.events.insert.mock.calls[0]).toEqual([
      expect.objectContaining({ requestBody: expect.objectContaining({ summary: "#2530 Rough-in — Dave" }) }),
    ]);
    expect(writes).toEqual([{ table: "job_bookings", id: "bk-1", payload: { google_event_id: "ev-new-1" } }]);
    expect(result).toMatchObject({ created: 1, warnings: [] });
  });

  it("adopts the legacy event for the only booking: updates it, links it, clears the job's link", async () => {
    const { supabase, writes } = fakeSupabase({ bookings: [BOOKING], job: { ...JOB, google_event_id: "ev-legacy" } });
    const calendar = fakeCalendar();

    const result = await syncJobCalendar(supabase, calendar, "job-1");

    expect(calendar.events.insert).not.toHaveBeenCalled();
    expect(calendar.events.delete).not.toHaveBeenCalled();
    expect(calendar.events.update.mock.calls[0]).toEqual([expect.objectContaining({ eventId: "ev-legacy" })]);
    expect(writes).toEqual([
      { table: "job_bookings", id: "bk-1", payload: { google_event_id: "ev-legacy" } },
      { table: "jobs", id: "job-1", payload: { google_event_id: null } },
    ]);
    expect(result).toMatchObject({ adopted: 1 });
  });

  it("recreates a booking's event Google no longer has, and links the new one", async () => {
    const { supabase, writes } = fakeSupabase({ bookings: [{ ...BOOKING, google_event_id: "ev-lost" }], job: JOB });
    const calendar = fakeCalendar();
    calendar.events.update.mockRejectedValueOnce(Object.assign(new Error("gone"), { code: 404 }));

    await syncJobCalendar(supabase, calendar, "job-1");

    expect(calendar.events.insert).toHaveBeenCalledTimes(1);
    expect(writes).toEqual([{ table: "job_bookings", id: "bk-1", payload: { google_event_id: "ev-new-1" } }]);
  });

  it("deletes the stray event of a booking that is gone", async () => {
    const { supabase } = fakeSupabase({ bookings: [{ ...BOOKING, google_event_id: "ev-1" }], job: JOB });
    const calendar = fakeCalendar([
      { id: "ev-1", bookingId: "bk-1" },
      { id: "ev-stray", bookingId: "bk-old" },
    ]);

    const result = await syncJobCalendar(supabase, calendar, "job-1");

    expect(calendar.events.delete).toHaveBeenCalledTimes(1);
    expect(calendar.events.delete.mock.calls[0]).toEqual([expect.objectContaining({ eventId: "ev-stray" })]);
    expect(result).toMatchObject({ updated: 1, deleted: 1 });
  });

  it("reports bookingsMissing (no Google calls) when job_bookings does not exist yet", async () => {
    const calendar = fakeCalendar();
    const supabase = {
      from: () => {
        const api: Record<string, unknown> = {
          select: () => api,
          eq: () => api,
          order: async () => ({ data: null, error: { code: "PGRST205", message: "no table" } }),
        };
        return api;
      },
    };

    const result = await syncJobCalendar(supabase, calendar, "job-1");

    expect(result.bookingsMissing).toBe(true);
    expect(calendar.events.list).not.toHaveBeenCalled();
  });
});
