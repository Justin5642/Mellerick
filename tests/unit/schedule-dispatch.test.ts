import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { applyScheduleChange } from "@/lib/schedule-dispatch";

// ============================================================================
// Item 1.8, first half — the drag that never reached Google.
//
// The schedule board writes the new day and the new technician straight to the
// jobs table and then calls `toast.success`. Nothing pushes the change to
// Google Calendar. Every OTHER schedule-changing surface in the product does:
// job creation (app/dashboard/jobs/new), the approvals screen, the job
// overview, sign-off, and the whole mobile app (ScheduleRepository enqueues a
// coalesced sync-calendar after every job write). The board — the one screen
// whose entire purpose is moving jobs around — was the exception.
//
// On its own that is a stale calendar. Combined with the poll in lib/google.ts
// it was data loss: the calendar kept the old time, the poll read it back, and
// the drag was undone in the database. Both halves are fixed together because
// either one alone leaves a live path to the same outcome.
//
// WHY A SEAM AND NOT A COMPONENT TEST. The web suite runs in `node` with no
// DOM (vitest.config.ts) and the board is a dnd-kit component. Adding a DOM
// harness to assert one call would be a large change for a small claim. The
// dispatch logic is pulled into lib/schedule-dispatch.ts instead — which also
// gives web the same shape mobile already has — and the scanner at the bottom
// makes sure the board actually routes through it rather than growing a second
// path back to the raw table.
// ============================================================================

type UpdateCall = { table: string; patch: Record<string, unknown>; id: string };

/** PostgREST-shaped fake. `.eq()` is the thenable, as in the real client. */
function fakeClient(error: { message: string } | null) {
  const calls: UpdateCall[] = [];
  return {
    calls,
    client: {
      from(table: string) {
        let patch: Record<string, unknown> = {};
        const api = {
          update(p: Record<string, unknown>) {
            patch = p;
            return api;
          },
          eq(_col: string, id: string) {
            calls.push({ table, patch, id });
            return Promise.resolve({ error });
          },
        };
        return api;
      },
    },
  };
}

/** Typed as `typeof fetch` so `mock.calls[0][0]` is indexable and real-shaped. */
const okFetch = () => vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ updated: true }), { status: 200 }));

describe("applyScheduleChange — the write", () => {
  it("updates only the columns it was given, on the job it was given", async () => {
    const { client, calls } = fakeClient(null);

    await applyScheduleChange(client, "job1", { scheduled_start: "2026-08-11T08:00:00.000Z" }, okFetch());

    expect(calls).toEqual([
      { table: "jobs", patch: { scheduled_start: "2026-08-11T08:00:00.000Z" }, id: "job1" },
    ]);
  });

  it("reports the database's refusal instead of reporting success", async () => {
    const { client } = fakeClient({ message: "new row violates row-level security policy" });

    const result = await applyScheduleChange(client, "job1", { assigned_to: "tech1" }, okFetch());

    expect(result).toEqual({ ok: false, error: "new row violates row-level security policy" });
  });
});

describe("applyScheduleChange — the calendar push", () => {
  it("pushes the job to Google after the write lands", async () => {
    const { client } = fakeClient(null);
    const fetchImpl = okFetch();

    const result = await applyScheduleChange(client, "job1", { scheduled_start: "x" }, fetchImpl);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][0]).toBe("/api/jobs/job1/sync-calendar");
    expect(fetchImpl.mock.calls[0][1]).toMatchObject({ method: "POST" });
    expect(result).toEqual({ ok: true, calendarSynced: true });
  });

  it("does NOT push when the write was refused", async () => {
    // Pushing here would send Google a time the database rejected — the two
    // systems would disagree, and the poll would then write the rejected time
    // onto some other job's event. Nothing changed, so nothing is pushed.
    const { client } = fakeClient({ message: "denied" });
    const fetchImpl = okFetch();

    await applyScheduleChange(client, "job1", { scheduled_start: "x" }, fetchImpl);

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("says the calendar is out of step rather than swallowing a failed push", async () => {
    // The existing call sites all use `.catch(() => {})`. That is how a job can
    // sit with a schedule the calendar has never heard of, which is the exact
    // state the poll used to resolve in the wrong direction.
    const { client } = fakeClient(null);
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response("nope", { status: 500 }));

    const result = await applyScheduleChange(client, "job1", { scheduled_start: "x" }, fetchImpl);

    expect(result).toEqual({ ok: true, calendarSynced: false });
  });

  it("survives the network being gone, and still reports the write succeeded", async () => {
    const { client } = fakeClient(null);
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });

    const result = await applyScheduleChange(client, "job1", { scheduled_start: "x" }, fetchImpl);

    // The row DID change. Telling the user the drag failed would be a lie that
    // makes them drag it again.
    expect(result).toEqual({ ok: true, calendarSynced: false });
  });
});

describe("the schedule board routes through the seam", () => {
  const BOARD = join(process.cwd(), "components/schedule/team-schedule-view.tsx");
  const src = readFileSync(BOARD, "utf8");

  it("does not write schedule or assignment columns straight to the jobs table", () => {
    // The regression this file exists to prevent: a new drag handler that
    // writes the table directly and never tells Google. Matching the update
    // payload rather than the import means adding a second raw write fails
    // here even if the import is still present.
    const rawWrites = src
      .split("\n")
      .map((line, i) => [i + 1, line] as const)
      .filter(([, line]) => /\.update\(\{[^}]*\b(scheduled_start|scheduled_end|assigned_to)\b/.test(line))
      .map(([n, line]) => `${n}: ${line.trim()}`);

    expect(rawWrites).toEqual([]);
  });

  it("actually calls the dispatcher", () => {
    // Without this the test above passes for a board that stopped writing at
    // all — which is green, and broken.
    expect(src).toContain("applyScheduleChange");
  });
});
