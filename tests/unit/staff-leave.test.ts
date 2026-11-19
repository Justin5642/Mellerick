import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  bookingLeaveConflicts,
  bookingsNeedingReassignment,
  buildLeaveIndex,
  canSeeLeaveType,
  describeLeaveConflicts,
  isLeaveSourceMissing,
  leaveColour,
  leaveDateKeys,
  leaveDayLabel,
  leaveDays,
  leaveFetchRange,
  leaveLabel,
  leaveRangeLabel,
  validateLeaveTimes,
  type ScheduleLeave,
} from "@/lib/staff-leave";
import { fromBusinessInputValue } from "@/lib/date";
import { businessDayRange } from "@/lib/scheduling";

const DAVE = "dave";
const SAM = "sam";

function leave(over: Partial<ScheduleLeave> = {}): ScheduleLeave {
  return {
    id: "l1",
    staff_id: DAVE,
    start_date: "2026-11-18", // Wednesday
    end_date: "2026-11-18",
    hours: 7.6,
    start_time: null,
    end_time: null,
    leave_type: "sick",
    ...over,
  };
}

const at = (key: string, time: string) => fromBusinessInputValue(`${key}T${time}`);
function booking(id: string, startKey: string, endKey: string, from = "07:00", to = "15:30", staff: string | null = DAVE) {
  return { id, staff_id: staff, starts_at: at(startKey, from), ends_at: at(endKey, to), daily: startKey !== endKey };
}

describe("leave days", () => {
  it("covers the weekdays of a range and skips the weekend inside it", () => {
    // Fri 20 Nov .. Tue 24 Nov 2026
    expect(leaveDateKeys({ start_date: "2026-11-20", end_date: "2026-11-24" })).toEqual(["2026-11-20", "2026-11-23", "2026-11-24"]);
  });

  it("keeps a weekend-only range, entered deliberately", () => {
    expect(leaveDateKeys({ start_date: "2026-11-21", end_date: "2026-11-22" })).toEqual(["2026-11-21", "2026-11-22"]);
  });

  it("is empty for an end before the start", () => {
    expect(leaveDateKeys({ start_date: "2026-11-20", end_date: "2026-11-19" })).toEqual([]);
  });

  it("spreads a multi-day period's hours evenly: 3 × 7.6 h is three full days", () => {
    const days = leaveDays(leave({ start_date: "2026-11-17", end_date: "2026-11-19", hours: 22.8 }));
    expect(days.map((d) => [d.dateKey, d.hours, d.fullDay])).toEqual([
      ["2026-11-17", 7.6, true],
      ["2026-11-18", 7.6, true],
      ["2026-11-19", 7.6, true],
    ]);
    // A full day covers the whole Melbourne day.
    expect(days[0].startIso).toBe(at("2026-11-17", "00:00"));
    expect(days[0].endIso).toBe(at("2026-11-18", "00:00"));
  });

  it("treats a half day of unknown time as a part day covering the whole day", () => {
    const [d] = leaveDays(leave({ hours: 3.8 }));
    expect(d.fullDay).toBe(false);
    expect(d.timed).toBe(false);
    expect(leaveDayLabel(d)).toBe("Sick · 3.8 h");
  });

  it("uses start/end times (Melbourne) for a timed part day", () => {
    const [d] = leaveDays(leave({ hours: 3.5, start_time: "12:00:00", end_time: "15:30" }));
    expect(d.timed).toBe(true);
    expect(d.fullDay).toBe(false);
    expect(d.hours).toBe(3.5);
    expect(d.startIso).toBe(at("2026-11-18", "12:00"));
    expect(leaveDayLabel(d)).toBe("Sick · 12:00–15:30");
  });

  it("treats unknown hours as a full day", () => {
    expect(leaveDays(leave({ hours: null }))[0].fullDay).toBe(true);
  });

  it("spans exactly the Melbourne day the board uses (businessDayRange), DST days included", () => {
    for (const key of ["2026-10-02", "2026-04-03", "2026-11-18"]) {
      const [d] = leaveDays(leave({ start_date: key, end_date: key }));
      expect({ s: d.startIso, e: d.endIso }).toEqual({ s: businessDayRange(key).dayStartIso, e: businessDayRange(key).dayEndIso });
    }
  });
});

describe("labels and colours", () => {
  it("names each type, and a withheld type 'Unavailable'", () => {
    expect(leaveLabel("sick")).toBe("Sick");
    expect(leaveLabel("annual")).toBe("Annual leave");
    expect(leaveLabel("long_service")).toBe("Long service leave");
    expect(leaveLabel("mystery")).toBe("Leave");
    expect(leaveLabel(null)).toBe("Unavailable");
  });

  it("gives sick and a withheld type different colours", () => {
    expect(leaveColour("sick").border).not.toBe(leaveColour(null).border);
    expect(leaveColour("annual").border).not.toBe(leaveColour("sick").border);
  });

  it("formats dates the same on every platform", () => {
    expect(leaveRangeLabel({ start_date: "2026-11-18", end_date: "2026-11-18" })).toBe("Wed 18 Nov");
    expect(leaveRangeLabel({ start_date: "2026-11-18", end_date: "2026-11-20" })).toBe("Wed 18 Nov – Fri 20 Nov");
  });

  it("validates part-day times", () => {
    expect(validateLeaveTimes("", "")).toBeNull();
    expect(validateLeaveTimes("12:00", "")).toMatch(/both/);
    expect(validateLeaveTimes("12:00", "11:00")).toMatch(/after/);
    expect(validateLeaveTimes("12:00", "15:30")).toBeNull();
  });
});

describe("the leave index", () => {
  it("puts each covered day under its person, only for the days shown", () => {
    const idx = buildLeaveIndex([leave({ start_date: "2026-11-17", end_date: "2026-11-20", hours: 30.4 })], ["2026-11-18", "2026-11-19"]);
    expect([...(idx.get(DAVE)?.keys() ?? [])]).toEqual(["2026-11-18", "2026-11-19"]);
    expect(idx.get(SAM)).toBeUndefined();
  });
});

describe("clashes with bookings", () => {
  it("flags a booking on a full sick day", () => {
    const c = bookingLeaveConflicts(booking("b1", "2026-11-18", "2026-11-18"), [leave()]);
    expect(c.map((x) => x.dateKey)).toEqual(["2026-11-18"]);
  });

  it("flags only the leave days of a multi-day booking", () => {
    const c = bookingLeaveConflicts(booking("b1", "2026-11-16", "2026-11-20"), [leave({ start_date: "2026-11-18", end_date: "2026-11-19", hours: 15.2 })]);
    expect(c.map((x) => x.dateKey)).toEqual(["2026-11-18", "2026-11-19"]);
  });

  it("does not flag another technician's booking", () => {
    expect(bookingLeaveConflicts(booking("b1", "2026-11-18", "2026-11-18", "07:00", "15:30", SAM), [leave()])).toEqual([]);
  });

  it("never flags an unassigned booking", () => {
    expect(bookingLeaveConflicts(booking("b1", "2026-11-18", "2026-11-18", "07:00", "15:30", null), [leave()])).toEqual([]);
  });

  it("a timed afternoon off clashes with an afternoon booking but not a morning one", () => {
    const pm = [leave({ hours: 3.5, start_time: "12:00", end_time: "15:30" })];
    expect(bookingLeaveConflicts(booking("am", "2026-11-18", "2026-11-18", "07:00", "11:30"), pm)).toEqual([]);
    expect(bookingLeaveConflicts(booking("pm", "2026-11-18", "2026-11-18", "13:00", "15:00"), pm)).toHaveLength(1);
  });

  it("a part day of unknown time clashes with anything that day", () => {
    const half = [leave({ hours: 3.8 })];
    expect(bookingLeaveConflicts(booking("am", "2026-11-18", "2026-11-18", "07:00", "09:00"), half)).toHaveLength(1);
  });

  it("does not flag a weekend booking inside a leave range that skips the weekend", () => {
    const c = bookingLeaveConflicts(booking("sat", "2026-11-21", "2026-11-21"), [leave({ start_date: "2026-11-20", end_date: "2026-11-23", hours: 15.2 })]);
    expect(c).toEqual([]);
  });

  it("lists the bookings that need reassigning, ignoring days before fromDateKey", () => {
    const bookings = [booking("past", "2026-11-17", "2026-11-17"), booking("now", "2026-11-18", "2026-11-18"), booking("free", "2026-11-25", "2026-11-25")];
    const l = [leave({ start_date: "2026-11-17", end_date: "2026-11-18", hours: 15.2 })];
    expect([...bookingsNeedingReassignment(bookings, l, "2026-11-18").keys()]).toEqual(["now"]);
    expect([...bookingsNeedingReassignment(bookings, l).keys()]).toEqual(["past", "now"]);
  });

  it("describes a clash with the label the caller may see", () => {
    const c = bookingLeaveConflicts(booking("b1", "2026-11-18", "2026-11-18"), [leave()]);
    expect(describeLeaveConflicts("Dave", c)).toBe("Dave is on leave: Sick Wed 18 Nov.");
    const hidden = bookingLeaveConflicts(booking("b1", "2026-11-18", "2026-11-18"), [leave({ leave_type: null })]);
    expect(describeLeaveConflicts("Dave", hidden)).toBe("Dave is unavailable: Unavailable Wed 18 Nov.");
  });
});

describe("who sees the type", () => {
  it("defaults to office and admin", () => {
    expect(canSeeLeaveType("admin")).toBe(true);
    expect(canSeeLeaveType("office")).toBe(true);
    expect(canSeeLeaveType("technician")).toBe(false);
    expect(canSeeLeaveType(null)).toBe(false);
  });
  it("follows the setting", () => {
    expect(canSeeLeaveType("office", "admin")).toBe(false);
    expect(canSeeLeaveType("technician", "everyone")).toBe(true);
  });
});

describe("graceful degradation and ranges", () => {
  it("treats a missing function/table/column as 'no leave yet'", () => {
    for (const code of ["42883", "PGRST202", "42P01", "PGRST205", "42703"]) expect(isLeaveSourceMissing({ code })).toBe(true);
    expect(isLeaveSourceMissing({ code: "42501" })).toBe(false);
    expect(isLeaveSourceMissing(null)).toBe(false);
  });
  it("pads the fetch range", () => {
    expect(leaveFetchRange(["2026-11-18", "2026-11-16"], 2)).toEqual({ from: "2026-11-14", to: "2026-11-20" });
    expect(leaveFetchRange([])).toBeNull();
  });
});

describe("lib/staff-leave.ts and mobile/lib/staffLeave.ts", () => {
  it("are identical below the imports (header comments aside)", () => {
    const body = (p: string) => {
      const lines = readFileSync(join(process.cwd(), p), "utf8").split("\n");
      let lastImport = -1;
      lines.forEach((line, i) => {
        if (line.startsWith("import ")) lastImport = i;
      });
      expect(lastImport).toBeGreaterThan(-1);
      return lines.slice(lastImport + 1).join("\n");
    };
    expect(body("mobile/lib/staffLeave.ts")).toBe(body("lib/staff-leave.ts"));
  });

  it("import the same names from the same mirrored modules", () => {
    const imports = (p: string) =>
      readFileSync(join(process.cwd(), p), "utf8")
        .split("\n")
        .filter((l) => l.startsWith("import "));
    expect(imports("mobile/lib/staffLeave.ts")).toEqual(imports("lib/staff-leave.ts"));
  });
});
