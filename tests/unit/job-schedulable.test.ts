import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CLOSED_JOB_STATUSES,
  JOB_CLOSED_ERRCODE,
  closedJobScheduleMessage,
  isJobClosedError,
  isJobClosedForScheduling,
} from "@/lib/job-schedulable";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const MIGRATION = "supabase/migrations/0096_refuse_scheduling_closed_jobs.sql";

describe("isJobClosedForScheduling", () => {
  it("is true only for the statuses the schedule board hides", () => {
    expect(isJobClosedForScheduling("completed")).toBe(true);
    expect(isJobClosedForScheduling("cancelled")).toBe(true);
    for (const s of ["pending", "scheduled", "in_progress", "on_hold"]) expect(isJobClosedForScheduling(s)).toBe(false);
    expect(isJobClosedForScheduling(null)).toBe(false);
    expect(isJobClosedForScheduling(undefined)).toBe(false);
  });

  it("agrees with the board's own filter and with the database refusal", () => {
    // The web board and the phone's Schedule tab filter on this exact list. A
    // job schedulable here but hidden there is the "saved but never appears"
    // bug again.
    expect(read("app/dashboard/schedule/page.tsx")).toContain(`.not("status", "in", '("completed","cancelled")')`);
    expect(read("mobile/app/(office)/schedule.tsx")).toContain(`.not("status", "in", '("completed","cancelled")')`);
    const sql = read(MIGRATION);
    expect(sql).toContain("in ('completed', 'cancelled')");
    expect(sql).toContain(`errcode = '${JOB_CLOSED_ERRCODE}'`);
    expect([...CLOSED_JOB_STATUSES].sort()).toEqual(["cancelled", "completed"]);
  });
});

describe("closedJobScheduleMessage", () => {
  it("says why and what to do", () => {
    expect(closedJobScheduleMessage("completed")).toMatch(/completed.*can't be scheduled.*reopen/i);
    expect(closedJobScheduleMessage("cancelled")).toMatch(/^This job is cancelled\. Cancelled jobs/);
  });
});

describe("isJobClosedError", () => {
  it("recognises the database refusal by code or by its sentence", () => {
    expect(isJobClosedError({ code: "MJ001", message: "x" })).toBe(true);
    expect(
      isJobClosedError({ message: "New bookings were not saved: Job #5 is completed. A completed job can't be scheduled — reopen it first." }),
    ).toBe(true);
    expect(isJobClosedError({ code: "42501", message: "permission denied" })).toBe(false);
    expect(isJobClosedError(null)).toBe(false);
  });

  it("matches the sentence the migration raises", () => {
    expect(read(MIGRATION)).toContain("can''t be scheduled — reopen it first.");
  });
});

describe("mobile mirror", () => {
  it("is identical", () => {
    expect(read("mobile/lib/jobSchedulable.ts")).toBe(read("lib/job-schedulable.ts"));
  });
});
