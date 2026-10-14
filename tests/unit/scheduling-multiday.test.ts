import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  workdayKeysBetween,
  scheduleDays,
  occupiesDay,
  scheduledHoursOnDay,
  totalScheduledHours,
  buildScheduleColumns,
  validateScheduleInput,
  scheduleInputFromJob,
  moveSchedule,
  isWeekendDateKey,
} from "@/lib/scheduling";
import { fromBusinessInputValue } from "@/lib/date";

// Calendar used below (Melbourne): Mon 19 Oct 2026 … Fri 23, Sat 24, Sun 25,
// Mon 26. DST began Sun 4 Oct 2026 (+10 → +11).
const at = (key: string, time: string) => fromBusinessInputValue(`${key}T${time}`);

describe("workdayKeysBetween", () => {
  it("skips weekends inside the range", () => {
    expect(workdayKeysBetween("2026-10-22", "2026-10-27")).toEqual(["2026-10-22", "2026-10-23", "2026-10-26", "2026-10-27"]);
  });

  it("books a weekend start or end date — it was picked deliberately", () => {
    expect(workdayKeysBetween("2026-10-24", "2026-10-24")).toEqual(["2026-10-24"]);
    expect(workdayKeysBetween("2026-10-24", "2026-10-25")).toEqual(["2026-10-24", "2026-10-25"]);
    expect(workdayKeysBetween("2026-10-24", "2026-10-27")).toEqual(["2026-10-24", "2026-10-26", "2026-10-27"]);
  });

  it("is empty when the end is before the start", () => {
    expect(workdayKeysBetween("2026-10-23", "2026-10-22")).toEqual([]);
  });

  it("knows the weekend", () => {
    expect(isWeekendDateKey("2026-10-24")).toBe(true);
    expect(isWeekendDateKey("2026-10-25")).toBe(true);
    expect(isWeekendDateKey("2026-10-26")).toBe(false);
  });
});

describe("scheduleDays", () => {
  it("a single-day job is one block on its start day, as before 0071", () => {
    const job = { scheduled_start: at("2026-10-21", "09:00"), scheduled_end: at("2026-10-21", "12:00") };
    expect(scheduleDays(job)).toEqual([{ dateKey: "2026-10-21", startIso: job.scheduled_start, endIso: job.scheduled_end }]);
  });

  it("a legacy continuous block that crosses midnight is still one block (schedule_daily false)", () => {
    const job = { scheduled_start: at("2026-10-21", "22:00"), scheduled_end: at("2026-10-22", "02:00"), schedule_daily: false };
    expect(scheduleDays(job)).toHaveLength(1);
    expect(totalScheduledHours(job)).toBe(4);
  });

  it("an all-day Thu–Tue job is 7:00–15:30 on each weekday, not one long block", () => {
    const cols = buildScheduleColumns({ startDateKey: "2026-10-22", endDateKey: "2026-10-27", startTime: "", endTime: "", allDay: true });
    const days = scheduleDays(cols);
    expect(days.map((d) => d.dateKey)).toEqual(["2026-10-22", "2026-10-23", "2026-10-26", "2026-10-27"]);
    expect(days[2]).toEqual({ dateKey: "2026-10-26", startIso: at("2026-10-26", "07:00"), endIso: at("2026-10-26", "15:30") });
    expect(occupiesDay(cols, "2026-10-24")).toBe(false);
    expect(occupiesDay(cols, "2026-10-26")).toBe(true);
    expect(scheduledHoursOnDay(cols, "2026-10-23")).toBe(8.5);
    expect(scheduledHoursOnDay(cols, "2026-10-25")).toBe(0);
    expect(totalScheduledHours(cols)).toBe(34);
  });

  it("keeps the wall-clock hours across the DST change", () => {
    const cols = buildScheduleColumns({ startDateKey: "2026-10-02", endDateKey: "2026-10-06", startTime: "07:00", endTime: "15:30", allDay: false });
    const days = scheduleDays(cols);
    expect(days.map((d) => d.dateKey)).toEqual(["2026-10-02", "2026-10-05", "2026-10-06"]);
    expect(days[0].startIso).toBe("2026-10-01T21:00:00.000Z"); // +10
    expect(days[1].startIso).toBe("2026-10-04T20:00:00.000Z"); // +11
    expect(days.every((d) => new Date(d.endIso).getTime() - new Date(d.startIso).getTime() === 8.5 * 3_600_000)).toBe(true);
  });

  it("is empty when unscheduled", () => {
    expect(scheduleDays({ scheduled_start: null, scheduled_end: null })).toEqual([]);
  });
});

describe("buildScheduleColumns / validateScheduleInput", () => {
  it("a single day is not daily; a range is", () => {
    const one = buildScheduleColumns({ startDateKey: "2026-10-21", endDateKey: "2026-10-21", startTime: "09:00", endTime: "11:00", allDay: false });
    expect(one).toEqual({ scheduled_start: at("2026-10-21", "09:00"), scheduled_end: at("2026-10-21", "11:00"), schedule_daily: false, schedule_all_day: false });
    const range = buildScheduleColumns({ startDateKey: "2026-10-21", endDateKey: "2026-10-23", startTime: "09:00", endTime: "11:00", allDay: false });
    expect(range.schedule_daily).toBe(true);
    expect(range.scheduled_end).toBe(at("2026-10-23", "11:00"));
  });

  it("all day ignores the typed times and uses the standard shift", () => {
    const cols = buildScheduleColumns({ startDateKey: "2026-10-21", endDateKey: "2026-10-21", startTime: "01:00", endTime: "02:00", allDay: true });
    expect(cols.scheduled_start).toBe(at("2026-10-21", "07:00"));
    expect(cols.scheduled_end).toBe(at("2026-10-21", "15:30"));
    expect(cols.schedule_all_day).toBe(true);
  });

  it("rejects an end date before the start, and a daily end time not after the start time", () => {
    expect(validateScheduleInput({ startDateKey: "2026-10-22", endDateKey: "2026-10-21", startTime: "09:00", endTime: "10:00", allDay: false })).toMatch(/end date/i);
    expect(validateScheduleInput({ startDateKey: "2026-10-21", endDateKey: "2026-10-23", startTime: "15:00", endTime: "09:00", allDay: false })).toMatch(/end time/i);
    expect(validateScheduleInput({ startDateKey: "2026-10-21", endDateKey: "2026-10-23", startTime: "", endTime: "", allDay: true })).toBeNull();
    expect(validateScheduleInput({ startDateKey: "2026-10-21", endDateKey: "2027-12-01", startTime: "09:00", endTime: "10:00", allDay: false })).toMatch(/longer than/);
  });

  it("round-trips through scheduleInputFromJob", () => {
    const input = { startDateKey: "2026-10-21", endDateKey: "2026-10-27", startTime: "08:00", endTime: "12:00", allDay: false };
    expect(scheduleInputFromJob(buildScheduleColumns(input))).toEqual(input);
  });
});

describe("moveSchedule", () => {
  it("a daily job keeps its hours and number of booked days, skipping the weekend", () => {
    // Mon–Wed (3 days) pasted on Thursday → Thu, Fri, Mon.
    const job = buildScheduleColumns({ startDateKey: "2026-10-19", endDateKey: "2026-10-21", startTime: "", endTime: "", allDay: true });
    const moved = moveSchedule(job, "2026-10-22")!;
    expect(moved).toEqual({ scheduled_start: at("2026-10-22", "07:00"), scheduled_end: at("2026-10-26", "15:30") });
    expect(scheduleDays({ ...moved, schedule_daily: true }).map((d) => d.dateKey)).toEqual(["2026-10-22", "2026-10-23", "2026-10-26"]);
  });

  it("pasted onto a Saturday keeps the Saturday and continues on weekdays", () => {
    const job = buildScheduleColumns({ startDateKey: "2026-10-19", endDateKey: "2026-10-21", startTime: "", endTime: "", allDay: true });
    const moved = moveSchedule(job, "2026-10-24")!;
    expect(scheduleDays({ ...moved, schedule_daily: true }).map((d) => d.dateKey)).toEqual(["2026-10-24", "2026-10-26", "2026-10-27"]);
  });

  it("a continuous block keeps its time of day and duration", () => {
    const job = { scheduled_start: at("2026-10-21", "22:00"), scheduled_end: at("2026-10-22", "02:00"), schedule_daily: false };
    expect(moveSchedule(job, "2026-10-26")).toEqual({ scheduled_start: at("2026-10-26", "22:00"), scheduled_end: at("2026-10-27", "02:00") });
  });
});

describe("lib/scheduling.ts and mobile/lib/scheduling.ts", () => {
  // Both platforms must agree on which days a job occupies, or the phone and
  // the board disagree about who is booked when. Only the header comment may
  // differ (it names the other copy).
  it("are identical below the header", () => {
    const body = (p: string) => readFileSync(join(process.cwd(), p), "utf8").split("\n").slice(6).join("\n");
    expect(body("mobile/lib/scheduling.ts")).toBe(body("lib/scheduling.ts"));
  });
});
