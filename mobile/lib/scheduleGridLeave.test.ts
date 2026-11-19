// The phone grid with staff leave (0112 — a draft, not applied yet): where a
// leave block sits, that it takes a lane of its own, and that the bookings on
// a leave day are flagged. The leave rules themselves are pinned on the web
// side (tests/unit/staff-leave.test.ts, which also checks this mirror).
import { fromBusinessInputValue } from "./date";
import { buildBoardIndex, daysByBooking, type BoardBooking, type BoardJob } from "./boardModel";
import { DEFAULT_DAY_END_HOUR, DEFAULT_DAY_START_HOUR, HOUR_WIDTH, LANE_HEIGHT, ROW_PADDING, WEEK_COLUMN_WIDTH, layoutDayRow, layoutWeekRow, rowHeight } from "./scheduleGrid";
import { bookingLeaveConflicts, bookingsNeedingReassignment, buildLeaveIndex, leaveDayLabel, type ScheduleLeave } from "./staffLeave";

const at = (key: string, time: string) => fromBusinessInputValue(`${key}T${time}`);
const MON = "2026-10-19";
const TUE = "2026-10-20";
const RANGE = { startHour: DEFAULT_DAY_START_HOUR, endHour: DEFAULT_DAY_END_HOUR };

const job: BoardJob = {
  id: "j1",
  job_number: 101,
  title: "Rough-in",
  status: "scheduled",
  scheduled_start: at(MON, "07:00"),
  scheduled_end: at(MON, "15:30"),
  assigned_to: "dave",
  crew: ["dave"],
};

function booking(id: string, key: string, from = "07:00", to = "15:30", staff = "dave"): BoardBooking {
  return { id, job_id: "j1", staff_id: staff, cost_center_id: null, starts_at: at(key, from), ends_at: at(key, to), daily: false, all_day: false };
}

function sick(over: Partial<ScheduleLeave> = {}): ScheduleLeave {
  return { id: null, staff_id: "dave", start_date: MON, end_date: MON, hours: 7.6, start_time: null, end_time: null, leave_type: "sick", ...over };
}

function entriesFor(bookings: BoardBooking[], keys: string[]) {
  const index = buildBoardIndex(bookings, new Map([[job.id, job]]), keys, daysByBooking(bookings));
  return (staff: string, key: string) => index.byStaff.get(staff)?.get(key) ?? [];
}

describe("Day view with leave", () => {
  it("draws a whole-day leave across the whole timeline in the top lane, the booking below it", () => {
    const b = [booking("b1", MON)];
    const leave = buildLeaveIndex([sick()], [MON]).get("dave")!.get(MON)!;
    const { items, height } = layoutDayRow(entriesFor(b, [MON])("dave", MON), leave, RANGE);
    const leaveItem = items.find((i) => i.kind === "leave")!;
    const bookingItem = items.find((i) => i.kind === "booking")!;
    expect(leaveItem.left).toBe(0);
    expect(leaveItem.width).toBe((DEFAULT_DAY_END_HOUR - DEFAULT_DAY_START_HOUR) * HOUR_WIDTH);
    expect(leaveItem.top).toBe(ROW_PADDING);
    expect(bookingItem.top).toBe(ROW_PADDING + LANE_HEIGHT);
    expect(height).toBe(rowHeight(2));
  });

  it("draws a timed part day over its hours only, beside a morning booking in the same lane", () => {
    const b = [booking("am", MON, "07:00", "11:30")];
    const leave = buildLeaveIndex([sick({ hours: 3.5, start_time: "12:00", end_time: "15:30" })], [MON]).get("dave")!.get(MON)!;
    const { items, height } = layoutDayRow(entriesFor(b, [MON])("dave", MON), leave, RANGE);
    const leaveItem = items.find((i) => i.kind === "leave")!;
    expect(leaveItem.left).toBe((12 - DEFAULT_DAY_START_HOUR) * HOUR_WIDTH);
    expect(leaveItem.width).toBe(3.5 * HOUR_WIDTH);
    expect(height).toBe(rowHeight(1));
    expect(leaveDayLabel((leaveItem as { day: Parameters<typeof leaveDayLabel>[0] }).day)).toBe("Sick · 12:00–15:30");
  });

  it("a row with no leave lays out exactly as before", () => {
    const b = [booking("b1", MON)];
    const { items, height } = layoutDayRow(entriesFor(b, [MON])("dave", MON), [], RANGE);
    expect(items.map((i) => i.kind)).toEqual(["booking"]);
    expect(height).toBe(rowHeight(1));
  });
});

describe("Week view with leave", () => {
  it("puts the leave chip first in its day column and pushes that day's bookings down", () => {
    const keys = [MON, TUE];
    const b = [booking("b1", MON), booking("b2", TUE)];
    const leave = buildLeaveIndex([sick()], keys);
    const get = entriesFor(b, keys);
    const { items, height } = layoutWeekRow(keys, (k) => get("dave", k), (k) => leave.get("dave")?.get(k) ?? []);
    const monLeave = items.find((i) => i.kind === "leave")!;
    expect(monLeave.left).toBe(3);
    expect(monLeave.top).toBe(ROW_PADDING);
    const mon = items.find((i) => i.kind === "booking" && i.id === "b1")!;
    const tue = items.find((i) => i.kind === "booking" && i.id === "b2")!;
    expect(mon.top).toBe(ROW_PADDING + LANE_HEIGHT);
    expect(tue.top).toBe(ROW_PADDING);
    expect(tue.left).toBe(WEEK_COLUMN_WIDTH + 3);
    expect(height).toBe(rowHeight(2));
  });
});

describe("flags and warnings on the phone", () => {
  it("flags Monday's booking for reassigning, not Tuesday's", () => {
    const flagged = bookingsNeedingReassignment([booking("b1", MON), booking("b2", TUE)], [sick()], MON);
    expect([...flagged.keys()]).toEqual(["b1"]);
  });

  it("warns when a move would put Sam's booking on Dave's sick day", () => {
    const moved = { ...booking("b1", MON, "07:00", "15:30", "sam"), staff_id: "dave" };
    expect(bookingLeaveConflicts(moved, [sick()], MON)).toHaveLength(1);
  });
});
