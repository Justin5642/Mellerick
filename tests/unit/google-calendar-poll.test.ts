import { describe, it, expect, vi, beforeEach } from "vitest";

// ============================================================================
// Item 1.8, second half — the poll that reverts the office's work.
//
// THE DEFECT. `pollGoogleCalendarChanges` exists to bring Google-side edits
// (drag an event, resize it, delete it) back onto the job. It decided whether
// to write purely on "do the times differ", with no notion of WHICH SIDE
// changed. So the reverse direction was indistinguishable from the forward
// one: if the app moved a job and the calendar had not caught up — the push
// failed, the push was never made (the schedule board never called it at all,
// which is the first half of 1.8), or a 410 forced a re-seed that re-listed
// every future event — the poll read the stale event and wrote the OLD time
// back onto the job.
//
// Nobody touched anything. A background cron silently undid an office user's
// drag, in the database, and the UI showed the reverted value on next load.
//
// THE RULE. Both systems stamp their own last-modification time: Google sets
// `event.updated`, Postgres maintains `jobs.updated_at` (0000_baseline.sql:295,
// via the update_updated_at trigger). Whichever is newer is the one holding
// the user's intent. That is the only signal available without a schema
// change, and it needs no migration — which matters, because migrations here
// are drafted and handed over, never applied.
//
// AND IT MUST CONVERGE. Refusing the write alone would leave the two systems
// permanently disagreeing: the app says Tuesday, the calendar says Monday, and
// nothing ever fixes it. So when the job wins, the poll pushes the job's times
// onto the event with the calendar client it already holds. That patch sets
// `event.updated` to now, so the next poll sees the event as newer — and by
// then the times match, so nothing is written. It settles in one round rather
// than oscillating.
//
// WHY MOCK `googleapis` RATHER THAN `getGoogleCalendarClient`. The client
// factory lives in the same module as the function under test, so vi.mock
// cannot replace it without replacing the subject too. Mocking the transport
// underneath means the real token refresh, the real paging loop, the real
// sync-token bookkeeping and the real write decisions all execute.
// ============================================================================

const eventsList = vi.fn();
const eventsPatch = vi.fn(async (..._args: unknown[]) => ({ data: {} }));

vi.mock("googleapis", () => {
  class OAuth2 {
    setCredentials() {}
    generateAuthUrl() {
      return "";
    }
    async refreshAccessToken() {
      return { credentials: { access_token: "refreshed", expiry_date: Date.now() + 3_600_000 } };
    }
  }
  return {
    google: {
      auth: { OAuth2 },
      calendar: () => ({ events: { list: (...a: unknown[]) => eventsList(...a), patch: (...a: unknown[]) => eventsPatch(...a) } }),
    },
  };
});

// The poll is always handed a client (service-role for cron, cookie-based for
// the manual button). If it ever builds its own, that is a bug on its own.
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => {
    throw new Error("pollGoogleCalendarChanges must use the client it is given");
  },
}));

import { pollGoogleCalendarChanges } from "@/lib/google";

type Job = {
  id: string;
  scheduled_start: string | null;
  scheduled_end: string | null;
  status: string;
  updated_at: string | null;
};

const TOKEN = {
  id: "tok1",
  access_token: "at",
  refresh_token: "rt",
  token_expiry: new Date(Date.now() + 3_600_000).toISOString(),
  calendar_sync_token: "sync-1",
};

/**
 * Minimal PostgREST-shaped fake. `.eq()` is deliberately BOTH chainable and
 * thenable so an `update().eq()` that nobody reads is still recorded — an
 * earlier fake in this repo returned a plain object there, which quietly
 * absorbed the very call its test existed to catch.
 */
function makeSupabase(jobsByEventId: Record<string, Job>) {
  const jobUpdates: Array<{ id: string; payload: Record<string, unknown> }> = [];
  const tokenUpdates: Array<Record<string, unknown>> = [];

  const from = (table: string) => {
    let payload: Record<string, unknown> | null = null;
    let filterValue: unknown = null;

    const record = () => {
      if (!payload) return;
      if (table === "jobs") jobUpdates.push({ id: String(filterValue), payload });
      else tokenUpdates.push(payload);
      payload = null;
    };

    const api: Record<string, unknown> = {
      select: () => api,
      update: (p: Record<string, unknown>) => {
        payload = p;
        return api;
      },
      eq: (_col: string, val: unknown) => {
        filterValue = val;
        return api;
      },
      single: async () => ({ data: table === "google_tokens" ? TOKEN : null, error: null }),
      maybeSingle: async () => ({ data: jobsByEventId[String(filterValue)] ?? null, error: null }),
      then: (onFulfilled: (v: { data: null; error: null }) => unknown, onRejected?: (e: unknown) => unknown) => {
        record();
        return Promise.resolve({ data: null, error: null }).then(onFulfilled, onRejected);
      },
    };
    return api;
  };

  return { supabase: { from }, jobUpdates, tokenUpdates };
}

function listReturns(items: unknown[]) {
  eventsList.mockResolvedValue({ data: { items, nextSyncToken: "sync-2" } });
}

/** An event Google last touched at `updated`, sitting at MONDAY 08:00–09:00. */
const MONDAY_START = "2026-08-10T08:00:00.000Z";
const MONDAY_END = "2026-08-10T09:00:00.000Z";
/** Where the office user dragged the job to: TUESDAY, same time of day. */
const TUESDAY_START = "2026-08-11T08:00:00.000Z";
const TUESDAY_END = "2026-08-11T09:00:00.000Z";

const staleEvent = (updated: string | null) => ({
  id: "evt1",
  status: "confirmed",
  updated,
  start: { dateTime: MONDAY_START },
  end: { dateTime: MONDAY_END },
});

const jobDraggedTo = (updatedAt: string | null): Job => ({
  id: "job1",
  scheduled_start: TUESDAY_START,
  scheduled_end: TUESDAY_END,
  status: "scheduled",
  updated_at: updatedAt,
});

beforeEach(() => {
  vi.clearAllMocks();
  eventsPatch.mockResolvedValue({ data: {} });
});

describe("pollGoogleCalendarChanges — the app's own edit must survive a poll", () => {
  it("does NOT write a stale event's times onto a job edited more recently", async () => {
    // Event last touched at 09:00. Office user dragged the job at 10:00.
    listReturns([staleEvent("2026-08-09T09:00:00.000Z")]);
    const { supabase, jobUpdates } = makeSupabase({ evt1: jobDraggedTo("2026-08-09T10:00:00.000Z") });

    await pollGoogleCalendarChanges(supabase);

    // THE BUG: before the fix this recorded
    //   { scheduled_start: MONDAY_START, scheduled_end: MONDAY_END }
    // — the drag, undone, in the database, by a cron nobody asked for.
    expect(jobUpdates).toEqual([]);
  });

  it("pushes the job's times onto the event when the job wins, so the two converge", async () => {
    listReturns([staleEvent("2026-08-09T09:00:00.000Z")]);
    const { supabase } = makeSupabase({ evt1: jobDraggedTo("2026-08-09T10:00:00.000Z") });

    await pollGoogleCalendarChanges(supabase);

    // Refusing the write alone would leave app and calendar disagreeing
    // forever. Patch the event instead — one round, then they match.
    expect(eventsPatch).toHaveBeenCalledTimes(1);
    expect(eventsPatch.mock.calls[0][0]).toMatchObject({
      calendarId: "primary",
      eventId: "evt1",
      requestBody: { start: { dateTime: TUESDAY_START }, end: { dateTime: TUESDAY_END } },
    });
  });

  it("STILL applies a genuine Google-side edit when the event is the newer writer", async () => {
    // The negative control. If this fails, the fix has not made the poll
    // careful — it has switched the feature off.
    listReturns([staleEvent("2026-08-09T11:00:00.000Z")]);
    const { supabase, jobUpdates } = makeSupabase({ evt1: jobDraggedTo("2026-08-09T10:00:00.000Z") });

    const result = await pollGoogleCalendarChanges(supabase);

    expect(jobUpdates).toEqual([
      { id: "job1", payload: { scheduled_start: MONDAY_START, scheduled_end: MONDAY_END } },
    ]);
    expect(eventsPatch).not.toHaveBeenCalled();
    expect(result).toMatchObject({ updated: 1 });
  });

  it("leaves the job alone when Google reports no modification time at all", async () => {
    // Without `updated` there is no way to tell who wrote last. The tie has to
    // break toward the side whose data a user is looking at.
    listReturns([staleEvent(null)]);
    const { supabase, jobUpdates } = makeSupabase({ evt1: jobDraggedTo("2026-08-09T10:00:00.000Z") });

    await pollGoogleCalendarChanges(supabase);

    expect(jobUpdates).toEqual([]);
  });

  it("treats a job with no updated_at as the older writer, so the event applies", async () => {
    listReturns([staleEvent("2026-08-09T09:00:00.000Z")]);
    const { supabase, jobUpdates } = makeSupabase({ evt1: jobDraggedTo(null) });

    await pollGoogleCalendarChanges(supabase);

    expect(jobUpdates).toHaveLength(1);
  });
});

describe("pollGoogleCalendarChanges — a deletion in Google must not wipe a newer schedule", () => {
  const cancelled = (updated: string | null) => ({ id: "evt1", status: "cancelled", updated });

  it("clears the dead event link but KEEPS the schedule the app set more recently", async () => {
    listReturns([cancelled("2026-08-09T09:00:00.000Z")]);
    const { supabase, jobUpdates } = makeSupabase({ evt1: jobDraggedTo("2026-08-09T10:00:00.000Z") });

    await pollGoogleCalendarChanges(supabase);

    // The event really is gone, so the link must go. The schedule must not:
    // wiping it loses an edit the office made after the deletion.
    expect(jobUpdates).toEqual([{ id: "job1", payload: { google_event_id: null } }]);
  });

  it("still clears the whole schedule when the deletion is the newer action", async () => {
    listReturns([cancelled("2026-08-09T11:00:00.000Z")]);
    const { supabase, jobUpdates } = makeSupabase({ evt1: jobDraggedTo("2026-08-09T10:00:00.000Z") });

    const result = await pollGoogleCalendarChanges(supabase);

    expect(jobUpdates).toEqual([
      { id: "job1", payload: { scheduled_start: null, scheduled_end: null, google_event_id: null } },
    ]);
    expect(result).toMatchObject({ clearedByDeletion: 1 });
  });
});

describe("pollGoogleCalendarChanges — the fake itself is not absorbing writes", () => {
  it("records a job update when one genuinely happens", async () => {
    // Guards against the failure mode that made an earlier test in this repo
    // vacuous: a fake whose .eq() swallowed the call it was meant to catch.
    // If this ever goes green while the tests above also pass trivially, the
    // fake has stopped observing writes.
    listReturns([staleEvent("2026-08-09T11:00:00.000Z")]);
    const { supabase, jobUpdates, tokenUpdates } = makeSupabase({ evt1: jobDraggedTo("2026-08-09T10:00:00.000Z") });

    await pollGoogleCalendarChanges(supabase);

    expect(jobUpdates.length).toBeGreaterThan(0);
    // And the sync-token bookkeeping still runs, so the paging loop completed.
    expect(tokenUpdates).toEqual([
      expect.objectContaining({ calendar_sync_token: "sync-2" }),
    ]);
  });
});
