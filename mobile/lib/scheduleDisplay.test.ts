import { buildScheduleColumns } from "./scheduling";
import { fromBusinessInputValue } from "./date";
import { businessTodayKey, dateRangeLabel, formatScheduleSummary, scheduleDayOn, shortTime } from "./scheduleDisplay";

// Calendar: Mon 19 Oct 2026 … Fri 23, Sat 24, Sun 25, Mon 26 (Melbourne, +11).
const at = (key: string, time: string) => fromBusinessInputValue(`${key}T${time}`);

describe("scheduleDisplay", () => {
  it("summarises an all-day Mon–Wed job with its daily hours and day count", () => {
    const cols = buildScheduleColumns({ startDateKey: "2026-10-19", endDateKey: "2026-10-21", startTime: "", endTime: "", allDay: true });
    expect(formatScheduleSummary(cols)).toBe("Mon 19 – Wed 21 Oct, 7:00–15:30 each weekday · 3 days");
  });

  it("counts booked days, not calendar days, across a weekend and a month end", () => {
    const cols = buildScheduleColumns({ startDateKey: "2026-10-30", endDateKey: "2026-11-03", startTime: "08:00", endTime: "12:00", allDay: false });
    expect(formatScheduleSummary(cols)).toBe("Fri 30 Oct – Tue 3 Nov, 8:00–12:00 each weekday · 3 days");
  });

  it("a single-day job is one date and its times", () => {
    expect(formatScheduleSummary({ scheduled_start: at("2026-10-21", "09:00"), scheduled_end: at("2026-10-21", "12:00") })).toBe(
      "Wed 21 Oct, 9:00–12:00"
    );
    expect(formatScheduleSummary({ scheduled_start: at("2026-10-21", "09:00"), scheduled_end: null })).toBe("Wed 21 Oct, 9:00");
    expect(formatScheduleSummary({ scheduled_start: null, scheduled_end: null })).toBeNull();
  });

  it("finds the job's block on a given day, with its position", () => {
    const cols = buildScheduleColumns({ startDateKey: "2026-10-22", endDateKey: "2026-10-26", startTime: "", endTime: "", allDay: true });
    expect(scheduleDayOn(cols, "2026-10-24")).toBeNull(); // Saturday inside the range
    const mon = scheduleDayOn(cols, "2026-10-26")!;
    expect(mon).toMatchObject({ dateKey: "2026-10-26", startIso: at("2026-10-26", "07:00"), index: 2, count: 3 });
  });

  it("today is the Melbourne day, not the device's", () => {
    // 14:30 UTC on the 21st is 01:30 on the 22nd in Melbourne.
    expect(businessTodayKey(new Date("2026-10-21T14:30:00Z"))).toBe("2026-10-22");
  });

  it("formats labels", () => {
    expect(dateRangeLabel("2026-10-21", "2026-10-21")).toBe("Wed 21 Oct");
    expect(shortTime(at("2026-10-21", "15:30"))).toBe("15:30");
  });
});
