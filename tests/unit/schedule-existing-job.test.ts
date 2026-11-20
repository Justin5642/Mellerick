import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  canScheduleExistingJob,
  isScheduleSearchable,
  parseSchedulePrefill,
  scheduleExistingJobHref,
  scheduleJobNumberQuery,
  scheduleSearchTokens,
  SCHEDULE_SEARCH_COLUMNS,
  SCHEDULE_SEARCH_LIMIT,
} from "@/lib/schedule-existing-job";

const body = (f: string) => {
  const src = readFileSync(f, "utf8");
  return src.slice(src.indexOf("\n\n") + 2);
};

const TECH = "11111111-1111-4111-8111-111111111111";

describe("schedule an existing job", () => {
  it("the phone's copy is byte-identical below its header", () => {
    expect(body("mobile/lib/scheduleExistingJob.ts")).toBe(body("lib/schedule-existing-job.ts"));
    expect(body("lib/schedule-existing-job.ts").length).toBeGreaterThan(500);
  });

  it("searches at most 20 jobs and reads no money", () => {
    expect(SCHEDULE_SEARCH_LIMIT).toBe(20);
    expect(SCHEDULE_SEARCH_COLUMNS).not.toMatch(/rate|cost|price|amount|total|value/i);
  });

  it("offers open jobs only", () => {
    for (const status of ["pending", "scheduled", "in_progress", "on_hold"]) expect(canScheduleExistingJob({ status })).toBe(true);
    expect(canScheduleExistingJob({ status: "completed" })).toBe(false);
    expect(canScheduleExistingJob({ status: "cancelled" })).toBe(false);
  });

  it("reads the box as a job number or words", () => {
    expect(scheduleJobNumberQuery("#834")).toBe(834);
    expect(scheduleJobNumberQuery(" 12 ")).toBe(12);
    expect(scheduleJobNumberQuery("12a")).toBeNull();
    expect(scheduleSearchTokens(' Lot 7, (Smith) "x" ')).toEqual(["Lot", "7", "Smith", "x"]);
    expect(isScheduleSearchable("5")).toBe(true);
    expect(isScheduleSearchable("a")).toBe(false);
    expect(isScheduleSearchable("ab")).toBe(true);
  });

  it("links to the job's Schedule dialog with the clicked technician and day", () => {
    expect(scheduleExistingJobHref("j1")).toBe("/dashboard/jobs/j1?schedule=1");
    expect(scheduleExistingJobHref("j1", { staffId: TECH, dateKey: "2026-11-23" })).toBe(`/dashboard/jobs/j1?schedule=1&tech=${TECH}&day=2026-11-23`);
    expect(scheduleExistingJobHref("j1", { staffId: null, dateKey: "2026-11-23" })).toBe("/dashboard/jobs/j1?schedule=1&day=2026-11-23");
    expect(scheduleExistingJobHref("j1", { staffId: "not-an-id", dateKey: "2026-02-30" })).toBe("/dashboard/jobs/j1?schedule=1");
  });

  it("prefills only an active technician and a real day", () => {
    expect(parseSchedulePrefill(TECH, "2026-11-23", [TECH])).toEqual({ staffId: TECH, dateKey: "2026-11-23" });
    expect(parseSchedulePrefill(TECH, "2026-11-23", [])).toEqual({ staffId: null, dateKey: "2026-11-23" });
    expect(parseSchedulePrefill(TECH, null, [TECH])).toEqual({ staffId: TECH, dateKey: null });
    expect(parseSchedulePrefill("x", "2026-13-01", ["x"])).toBeNull();
    expect(parseSchedulePrefill(null, null, [])).toBeNull();
  });
});
