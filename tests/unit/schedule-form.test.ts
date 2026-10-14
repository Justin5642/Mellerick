import { describe, it, expect } from "vitest";
import {
  CLEARED_SCHEDULE,
  countTechnicianJobsOnDay,
  describeSchedule,
  formatDateKeyRange,
  formatScheduleDates,
  formatScheduleHours,
  nextScheduleDay,
  sameScheduleInput,
  scheduleColumnsFromForm,
  scheduleDayOn,
  scheduleFormFromJob,
  scheduleOverlapOrFilter,
  withStartDate,
} from "@/lib/schedule-form";
import { buildScheduleColumns, type ScheduleInput } from "@/lib/scheduling";
import { fromBusinessInputValue } from "@/lib/date";

// Calendar (Melbourne): Mon 19 Oct 2026 … Fri 23, Sat 24, Sun 25, Mon 26.
const at = (key: string, time: string) => fromBusinessInputValue(`${key}T${time}`);
const input = (over: Partial<ScheduleInput> = {}): ScheduleInput => ({
  startDateKey: "2026-10-19",
  endDateKey: "2026-10-19",
  startTime: "07:00",
  endTime: "15:30",
  allDay: false,
  ...over,
});
const allDayMonWed = buildScheduleColumns(input({ endDateKey: "2026-10-21", allDay: true }));

describe("withStartDate — the end date follows a single-day job", () => {
  it("moves the end with the start while the job is one day", () => {
    expect(withStartDate(input(), "2026-10-22")).toMatchObject({ startDateKey: "2026-10-22", endDateKey: "2026-10-22" });
  });

  it("fills a blank end date", () => {
    expect(withStartDate(input({ startDateKey: "", endDateKey: "" }), "2026-10-22").endDateKey).toBe("2026-10-22");
  });

  it("keeps a deliberate range's end, unless the new start passes it", () => {
    const range = input({ endDateKey: "2026-10-23" });
    expect(withStartDate(range, "2026-10-20").endDateKey).toBe("2026-10-23");
    expect(withStartDate(range, "2026-10-26").endDateKey).toBe("2026-10-26");
  });
});

describe("scheduleColumnsFromForm", () => {
  it("an optional form with no start date clears all four columns", () => {
    expect(scheduleColumnsFromForm(input({ startDateKey: "", endDateKey: "" }), { optional: true })).toEqual({
      ok: true,
      columns: CLEARED_SCHEDULE,
    });
    expect(CLEARED_SCHEDULE).toEqual({ scheduled_start: null, scheduled_end: null, schedule_daily: false, schedule_all_day: false });
  });

  it("the wizard needs a date", () => {
    expect(scheduleColumnsFromForm(input({ startDateKey: "", endDateKey: "" }), { optional: false })).toMatchObject({ ok: false });
  });

  it("builds the same columns as buildScheduleColumns, and passes on validation errors", () => {
    const range = input({ endDateKey: "2026-10-21", allDay: true });
    expect(scheduleColumnsFromForm(range, { optional: true })).toEqual({ ok: true, columns: buildScheduleColumns(range) });
    expect(scheduleColumnsFromForm(input({ startTime: "15:00", endTime: "09:00" }), { optional: true })).toMatchObject({
      ok: false,
      error: expect.stringMatching(/end time/i),
    });
  });
});

describe("sameScheduleInput — Overview only rewrites a schedule that was edited", () => {
  it("All day ignores the typed times", () => {
    expect(sameScheduleInput(input({ allDay: true }), input({ allDay: true, startTime: "09:00" }))).toBe(true);
    expect(sameScheduleInput(input(), input({ startTime: "09:00" }))).toBe(false);
  });

  it("two unscheduled forms are the same; a changed end date is not", () => {
    expect(sameScheduleInput(input({ startDateKey: "" }), input({ startDateKey: "", startTime: "01:00" }))).toBe(true);
    expect(sameScheduleInput(input(), input({ endDateKey: "2026-10-20" }))).toBe(false);
  });

  it("a saved job round-trips unchanged", () => {
    expect(sameScheduleInput(scheduleFormFromJob({ ...allDayMonWed }), input({ endDateKey: "2026-10-21", allDay: true }))).toBe(true);
  });

  it("an unscheduled job opens as a blank form", () => {
    expect(scheduleFormFromJob({ scheduled_start: null, scheduled_end: null }).startDateKey).toBe("");
  });
});

describe("scheduleOverlapOrFilter", () => {
  it("ends after the range start, or has no end and starts inside it", () => {
    expect(scheduleOverlapOrFilter("2026-10-20T13:00:00.000Z")).toBe(
      "scheduled_end.gt.2026-10-20T13:00:00.000Z,and(scheduled_end.is.null,scheduled_start.gte.2026-10-20T13:00:00.000Z)"
    );
  });
});

describe("countTechnicianJobsOnDay — the wizard's All-day default", () => {
  const tue = "2026-10-20";

  it("counts a multi-day job that started earlier, via assigned_to OR job_assignments, once per job", () => {
    const jobs = [
      { id: "range", assigned_to: "amy", ...allDayMonWed },
      {
        id: "crew",
        assigned_to: "bob",
        scheduled_start: at(tue, "09:00"),
        scheduled_end: at(tue, "11:00"),
        schedule_daily: false,
      },
    ];
    const assignments = [
      { job_id: "range", staff_id: "amy" }, // same job twice for amy — counted once
      { job_id: "crew", staff_id: "amy" }, // amy is second on bob's crew job (trap 10)
    ];
    expect(countTechnicianJobsOnDay(jobs, assignments, ["amy", "bob", "cat"], tue)).toEqual({ amy: 2, bob: 1 });
  });

  it("ignores a job whose span only crosses the day (a weekend inside a range)", () => {
    const thuToMon = { id: "r", assigned_to: "amy", ...buildScheduleColumns(input({ startDateKey: "2026-10-22", endDateKey: "2026-10-26" })) };
    expect(countTechnicianJobsOnDay([thuToMon], [], ["amy"], "2026-10-24")).toEqual({});
    expect(countTechnicianJobsOnDay([thuToMon], [], ["amy"], "2026-10-26")).toEqual({ amy: 1 });
  });

  it("ignores technicians who were not picked", () => {
    const job = { id: "j", assigned_to: "zed", ...buildScheduleColumns(input({ startDateKey: tue, endDateKey: tue })) };
    expect(countTechnicianJobsOnDay([job], [], ["amy"], tue)).toEqual({});
  });
});

describe("scheduleDayOn / nextScheduleDay — My Jobs and the dashboard", () => {
  it("a Mon–Wed job is on Tuesday's list with Tuesday's hours", () => {
    expect(scheduleDayOn(allDayMonWed, "2026-10-20")).toEqual({
      dateKey: "2026-10-20",
      startIso: at("2026-10-20", "07:00"),
      endIso: at("2026-10-20", "15:30"),
    });
    expect(scheduleDayOn(allDayMonWed, "2026-10-22")).toBeNull();
  });

  it("upcoming is dated by the next booked day, skipping a weekend inside the range", () => {
    const friToTue = buildScheduleColumns(input({ startDateKey: "2026-10-23", endDateKey: "2026-10-27" }));
    expect(nextScheduleDay(friToTue, "2026-10-24")?.dateKey).toBe("2026-10-26");
    expect(nextScheduleDay(friToTue, "2026-10-19")?.dateKey).toBe("2026-10-23");
    expect(nextScheduleDay(friToTue, "2026-10-28")).toBeNull();
  });
});

describe("display", () => {
  it("formats a range compactly, repeating the month only when it changes", () => {
    expect(formatDateKeyRange("2026-10-21", "2026-10-21")).toBe("Wed 21 Oct");
    expect(formatDateKeyRange("2026-10-19", "2026-10-21")).toBe("Mon 19 – Wed 21 Oct");
    expect(formatDateKeyRange("2026-10-30", "2026-11-03")).toBe("Fri 30 Oct – Tue 3 Nov");
    expect(formatDateKeyRange("2026-12-31", "2027-01-04")).toBe("Thu 31 Dec 2026 – Mon 4 Jan 2027");
  });

  it("describes a multi-day job: range, daily hours, days and total", () => {
    expect(describeSchedule(allDayMonWed)).toBe("Booked Mon 19 – Wed 21 Oct, 7:00–15:30 each weekday (3 days, 25.5 h)");
    expect(formatScheduleDates(allDayMonWed)).toBe("Mon 19 – Wed 21 Oct");
    expect(formatScheduleHours(allDayMonWed)).toBe("7:00–15:30");
  });

  it("does not say 'each weekday' when a weekend endpoint is booked", () => {
    const satToMon = buildScheduleColumns(input({ startDateKey: "2026-10-24", endDateKey: "2026-10-26", startTime: "08:00", endTime: "12:00" }));
    expect(describeSchedule(satToMon)).toBe("Booked Sat 24 – Mon 26 Oct, 8:00–12:00 each booked day (2 days, 8 h)");
  });

  it("describes a single block, and nothing for an unscheduled job", () => {
    const one = buildScheduleColumns(input({ startDateKey: "2026-10-21", endDateKey: "2026-10-21", startTime: "09:00", endTime: "11:00" }));
    expect(describeSchedule(one)).toBe("Booked Wed 21 Oct, 9:00–11:00 (2 h)");
    expect(describeSchedule({ scheduled_start: null, scheduled_end: null })).toBeNull();
  });
});
