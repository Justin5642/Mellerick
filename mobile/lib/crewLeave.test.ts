import { crewJoinWindow, crewLeaveConflicts, describeCrewLeave } from "./crewLeave";
import type { ScheduleLeave } from "./staffLeave";

// Melbourne is UTC+11 in November: 07:00 local = 20:00Z the day before.
const TUE_7 = "2026-11-16T20:00:00.000Z"; // Tue 17 Nov 07:00
const TUE_1530 = "2026-11-17T04:30:00.000Z"; // Tue 17 Nov 15:30
const FRI_1530 = "2026-11-20T04:30:00.000Z"; // Fri 20 Nov 15:30 (daily Tue–Fri)

const booking = (over: Partial<{ starts_at: string; ends_at: string | null; daily: boolean; all_day: boolean; cost_center_id: string | null }> = {}) => ({
  starts_at: TUE_7,
  ends_at: TUE_1530,
  daily: false,
  all_day: true,
  cost_center_id: null,
  ...over,
});

const sick = (over: Partial<ScheduleLeave> = {}): ScheduleLeave => ({
  id: null,
  staff_id: "dave",
  start_date: "2026-11-17",
  end_date: "2026-11-17",
  hours: 7.6,
  start_time: null,
  end_time: null,
  leave_type: "sick",
  ...over,
});

describe("crewJoinWindow (0079: a newcomer is booked on the job's one shared window)", () => {
  it("is the bookings' window when they all share one", () => {
    const w = crewJoinWindow([booking(), booking({ starts_at: "2026-11-16T20:00:00Z", ends_at: "2026-11-17T04:30:00Z" })], {
      scheduled_start: TUE_7,
      scheduled_end: TUE_1530,
    });
    // The same instants however PostgREST formatted them.
    expect(w && { ...w, starts_at: Date.parse(w.starts_at), ends_at: Date.parse(w.ends_at!) }).toEqual({
      starts_at: Date.parse(TUE_7),
      ends_at: Date.parse(TUE_1530),
      daily: false,
    });
  });

  it("is null when the bookings differ — the newcomer joins with no booking", () => {
    expect(crewJoinWindow([booking(), booking({ ends_at: FRI_1530, daily: true })], { scheduled_start: TUE_7, scheduled_end: FRI_1530 })).toBeNull();
    // A different cost centre is a different window too.
    expect(crewJoinWindow([booking(), booking({ cost_center_id: "cc" })], { scheduled_start: TUE_7, scheduled_end: TUE_1530 })).toBeNull();
  });

  it("is null for a job with no bookings", () => {
    expect(crewJoinWindow([], { scheduled_start: TUE_7, scheduled_end: TUE_1530 })).toBeNull();
  });

  it("is the job's own window before 0079 (bookings unreadable)", () => {
    expect(crewJoinWindow(null, { scheduled_start: TUE_7, scheduled_end: FRI_1530, schedule_daily: true })).toEqual({
      starts_at: TUE_7,
      ends_at: FRI_1530,
      daily: true,
    });
    expect(crewJoinWindow(null, { scheduled_start: null, scheduled_end: null })).toBeNull();
  });
});

describe("crewLeaveConflicts / describeCrewLeave", () => {
  const window = { starts_at: TUE_7, ends_at: FRI_1530, daily: true };

  it("finds the leave days the window books them onto", () => {
    const c = crewLeaveConflicts("dave", window, [sick(), sick({ start_date: "2026-11-19", end_date: "2026-11-19", leave_type: null })], "2026-11-17");
    expect(c.map((x) => x.dateKey)).toEqual(["2026-11-17", "2026-11-19"]);
    expect(describeCrewLeave("Dave", c)).toBe("Dave isn't available then — Sick Tue 17 Nov, Unavailable Thu 19 Nov.");
  });

  it("ignores other people's leave, past days, and no window / no leave", () => {
    expect(crewLeaveConflicts("sam", window, [sick()], "2026-11-17")).toEqual([]);
    expect(crewLeaveConflicts("dave", window, [sick()], "2026-11-18")).toEqual([]);
    expect(crewLeaveConflicts("dave", null, [sick()], "2026-11-17")).toEqual([]);
    expect(crewLeaveConflicts("dave", window, [], "2026-11-17")).toEqual([]);
  });

  it("names a part day's hours and caps the list", () => {
    const leave = [sick({ start_date: "2026-11-17", end_date: "2026-11-20", hours: 8, leave_type: "annual" })];
    const c = crewLeaveConflicts("dave", window, leave, "2026-11-17");
    expect(c).toHaveLength(4);
    expect(describeCrewLeave("Dave", c, 2)).toBe("Dave isn't available then — Annual leave · 2 h Tue 17 Nov, Annual leave · 2 h Wed 18 Nov and 2 more days.");
  });
});
