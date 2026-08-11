import { describe, it, expect, vi } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

import { applyScheduleChange, pushJobToCalendar } from "@/lib/schedule-dispatch";

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

type UpdateCall = { table: string; patch: Record<string, unknown>; options: unknown; id: string };

/**
 * PostgREST-shaped fake. `.eq()` is the thenable, as in the real client.
 *
 * `rows` is how many rows the statement changed. It defaults to 1 because that
 * is the ordinary case; the interesting value is 0, which the real client
 * reports with a null error.
 */
function fakeClient(error: { message: string } | null, rows: number | null = 1) {
  const calls: UpdateCall[] = [];
  return {
    calls,
    client: {
      from(table: string) {
        let patch: Record<string, unknown> = {};
        let options: unknown;
        const api = {
          update(p: Record<string, unknown>, o?: unknown) {
            patch = p;
            options = o;
            return api;
          },
          eq(_col: string, id: string) {
            calls.push({ table, patch, options, id });
            return Promise.resolve({ error, count: rows });
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
      {
        table: "jobs",
        patch: { scheduled_start: "2026-08-11T08:00:00.000Z" },
        options: { count: "exact" },
        id: "job1",
      },
    ]);
  });

  it("reports the database's refusal instead of reporting success", async () => {
    const { client } = fakeClient({ message: "new row violates row-level security policy" });

    const result = await applyScheduleChange(client, "job1", { assigned_to: "tech1" }, okFetch());

    expect(result).toEqual({ ok: false, error: "new row violates row-level security policy" });
  });

  it("treats a write that changed no rows as a refusal, not a save", async () => {
    // PostgREST returns NO error for an UPDATE that matched nothing: RLS filters
    // the row out and the statement succeeds against zero rows. Read as success,
    // the board leaves the drag on screen and the job overview says "Job
    // updated" for a job that did not move — and Google is then told a time the
    // database does not hold.
    const { client } = fakeClient(null, 0);
    const fetchImpl = okFetch();

    const result = await applyScheduleChange(client, "job1", { scheduled_start: "x" }, fetchImpl);

    expect(result.ok).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("carries other job columns saved in the same submit", async () => {
    // The job overview saves the whole form in one statement — schedule columns
    // and title and status together. Splitting that into two writes to keep this
    // signature narrow would make a half-saved job reachable.
    const { client, calls } = fakeClient(null);

    await applyScheduleChange(client, "job1", { title: "Fix pump", scheduled_end: null }, okFetch());

    expect(calls[0].patch).toEqual({ title: "Fix pump", scheduled_end: null });
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

describe("pushJobToCalendar", () => {
  // The push on its own, for the screens that change a job in a way the seam
  // cannot express — sign-off completes it, an approval sends it back — but
  // still have to tell Google. They all used to write
  // `.catch(() => {})`, which is the same silence in a different place.
  it("reports whether Google actually accepted the push", async () => {
    const ok = vi.fn<typeof fetch>(async () => new Response(null, { status: 200 }));
    const refused = vi.fn<typeof fetch>(async () => new Response("nope", { status: 500 }));

    expect(await pushJobToCalendar("job1", ok)).toBe(true);
    expect(ok.mock.calls[0][0]).toBe("/api/jobs/job1/sync-calendar");
    expect(ok.mock.calls[0][1]).toMatchObject({ method: "POST" });
    expect(await pushJobToCalendar("job1", refused)).toBe(false);
  });

  it("reports a push that never left instead of throwing at the caller", async () => {
    const offline = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });

    expect(await pushJobToCalendar("job1", offline)).toBe(false);
  });
});

// ============================================================================
// The ratchet.
//
// It used to take ONE hardcoded path — the board — as its input. So the second
// surface that wrote the same three columns the same wrong way, and then fired
// the same `.catch(() => {})` push, sat one directory away from a guard written
// to forbid precisely that, and passed it. A guard that names its one known
// offender can only ever catch that offender; the bug it describes goes on
// happening everywhere it did not look.
//
// It now asks the question of the whole web app: who changes a job's schedule
// without going through the seam that tells Google?
//
// WHAT IT DELIBERATELY DOES NOT FLAG. Writes to other tables' assigned_to
// (equipment has one — app/dashboard/fleet/page.tsx — and no calendar event);
// INSERTs, because a new job has no id until the insert returns and the seam
// updates a row by id, so app/dashboard/jobs/new cannot route through it; and
// mobile/, which reaches the same end through its own outbox seam
// (ScheduleRepository) and would need a scanner shaped for that.
// ============================================================================

const ROOT = process.cwd();
const SCHEDULE_COLUMNS = /\b(scheduled_start|scheduled_end|assigned_to)\b/;

/** The text between the parens of a call whose `(` is at `open`. */
function callArguments(src: string, open: number): string {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "(") depth++;
    else if (src[i] === ")" && --depth === 0) return src.slice(open + 1, i);
  }
  return src.slice(open);
}

/** The table of the nearest preceding `.from("…")`, which is the one being written. */
function tableBefore(src: string, index: number): string | null {
  let table: string | null = null;
  for (const m of src.slice(0, index).matchAll(/\.from\(\s*["'`](\w+)["'`]\s*\)/g)) table = m[1];
  return table;
}

/**
 * Line numbers of every `jobs` UPDATE whose payload names a schedule column.
 *
 * The payload is read across its whole balanced-paren span rather than one line
 * at a time, because the form this ratchet missed spelled its columns on lines
 * 2-6 of the call. A single-line regex is a guard that only catches writes
 * short enough to fit on one line.
 */
function scheduleWriteLines(src: string): number[] {
  const lines: number[] = [];
  for (const m of src.matchAll(/\.update\(/g)) {
    const at = m.index!;
    if (tableBefore(src, at) !== "jobs") continue;
    if (!SCHEDULE_COLUMNS.test(callArguments(src, at + m[0].length - 1))) continue;
    lines.push(src.slice(0, at).split("\n").length);
  }
  return lines;
}

/** Every .ts/.tsx under the web app, skipping build output and dot-directories. */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (/\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

const SEAM = "lib/schedule-dispatch.ts";

// Files other than the seam that may write these columns directly. Kept as data
// so an addition is a visible decision carrying a stated reason, rather than a
// quiet edit to a regex that nobody reviews.
const EXEMPT: Record<string, string> = {
  "lib/google.ts":
    "the calendar -> app direction: the poll copies Google's times onto the job, " +
    "and pushing them straight back would be a loop, not a sync",
};

const scanned = ["app", "components", "lib"]
  .flatMap((d) => sourceFiles(join(ROOT, d)))
  .map((file) => ({ file, rel: relative(ROOT, file).replace(/\\/g, "/") }));

describe("the ratchet catches the shape it is looking for", () => {
  // A scanner is a claim about code it has never seen. These two pin the claim
  // to the actual regression, so a later "tidy-up" of the matching cannot
  // quietly reopen the hole while every other test stays green.
  it("flags the multi-line update job-overview used to have", () => {
    const old = [
      `const { error } = await supabase.from("jobs").update({`,
      `  ...form,`,
      `  site_id: form.site_id || null,`,
      `  assigned_to: form.assigned_to || null,`,
      `  scheduled_start: form.scheduled_start ? fromBusinessInputValue(form.scheduled_start) : null,`,
      `}).eq("id", job.id);`,
    ].join("\n");

    expect(scheduleWriteLines(old)).toEqual([1]);
  });

  it("does not flag another table that happens to have an assigned_to", () => {
    const equipment = `await supabase.from("equipment").update({ assigned_to: newAssignedTo }).eq("id", id);`;

    expect(scheduleWriteLines(equipment)).toEqual([]);
  });
});

describe("every surface that reschedules a job routes through the seam", () => {
  it("no file writes a job's schedule columns outside the seam", () => {
    const offenders = scanned
      .filter(({ rel }) => rel !== SEAM && !(rel in EXEMPT))
      .flatMap(({ file, rel }) => scheduleWriteLines(readFileSync(file, "utf8")).map((n) => `${rel}:${n}`));

    expect(offenders).toEqual([]);
  });

  it("keeps the exemption list honest", () => {
    // An exemption that no longer describes a real write is a hole standing
    // open for the next file that lands on that path.
    const unearned = Object.keys(EXEMPT).filter(
      (rel) => scheduleWriteLines(readFileSync(join(ROOT, rel), "utf8")).length === 0
    );

    expect(unearned).toEqual([]);
  });

  it("the schedule-writing surfaces actually call the dispatcher", () => {
    // Without this the scan above passes for a screen that stopped saving
    // altogether — which is green, and broken.
    for (const rel of ["components/schedule/team-schedule-view.tsx", "components/job/job-overview.tsx"]) {
      expect(readFileSync(join(ROOT, rel), "utf8"), rel).toContain("applyScheduleChange");
    }
  });
});
