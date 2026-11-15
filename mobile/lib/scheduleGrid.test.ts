import { fromBusinessInputValue } from "./date";
import { buildBoardIndex, daysByBooking, planBoardMove, type BoardBooking, type BoardJob } from "./boardModel";
import {
  bookingClashes,
  canResizeByDays,
  columnAt,
  dayBlockGeometry,
  dayTimelineHours,
  defaultGridView,
  gridRows,
  initials,
  legacyBookingsFor,
  MIN_TOUCH,
  moveBlockedReason,
  othersOnJobDay,
  packLanes,
  planResize,
  rowAt,
  rowHeight,
  rowOffsets,
  startOfWeekKey,
  stepDateKey,
  techShortLabel,
  visibleDayKeys,
  weekDateKeys,
  HOUR_WIDTH,
} from "./scheduleGrid";
import { scheduleDays } from "./scheduling";
import { bookingWindow } from "./bookings";

// Calendar (Melbourne): Mon 19 Oct 2026 … Fri 23, Sat 24, Sun 25, Mon 26.
const at = (key: string, time: string) => fromBusinessInputValue(`${key}T${time}`);

function booking(over: Partial<BoardBooking> & { id: string }): BoardBooking {
  return {
    job_id: "j1",
    staff_id: "dave",
    cost_center_id: null,
    starts_at: at("2026-10-19", "07:00"),
    ends_at: at("2026-10-19", "15:30"),
    daily: false,
    all_day: false,
    ...over,
  };
}

const job = (over: Partial<BoardJob> = {}): BoardJob => ({
  id: "j1",
  job_number: 101,
  title: "Rough-in",
  status: "scheduled",
  scheduled_start: at("2026-10-19", "07:00"),
  scheduled_end: at("2026-10-19", "15:30"),
  assigned_to: "dave",
  crew: ["dave"],
  ...over,
});

describe("views and days", () => {
  it("defaults to Day on a phone and Week on a tablet", () => {
    expect(defaultGridView(390)).toBe("day");
    expect(defaultGridView(599)).toBe("day");
    expect(defaultGridView(600)).toBe("week");
    expect(defaultGridView(1024)).toBe("week");
  });

  it("weeks run Monday to Sunday, as on the web board", () => {
    expect(startOfWeekKey("2026-10-21")).toBe("2026-10-19");
    expect(startOfWeekKey("2026-10-25")).toBe("2026-10-19"); // Sunday belongs to the week before
    expect(startOfWeekKey("2026-10-19")).toBe("2026-10-19");
    expect(weekDateKeys("2026-10-22")).toEqual([
      "2026-10-19",
      "2026-10-20",
      "2026-10-21",
      "2026-10-22",
      "2026-10-23",
      "2026-10-24",
      "2026-10-25",
    ]);
  });

  it("steps a day or a week, and shows one or seven days", () => {
    expect(stepDateKey("day", "2026-10-23", 1)).toBe("2026-10-24");
    expect(stepDateKey("week", "2026-10-23", -1)).toBe("2026-10-16");
    expect(visibleDayKeys("day", "2026-10-23")).toEqual(["2026-10-23"]);
    expect(visibleDayKeys("week", "2026-10-23")).toHaveLength(7);
  });

  it("crosses the DST change without skipping a date", () => {
    // DST began Sun 4 Oct 2026.
    expect(stepDateKey("day", "2026-10-03", 1)).toBe("2026-10-04");
    expect(weekDateKeys("2026-10-01")).toContain("2026-10-04");
  });
});

describe("hit testing", () => {
  it("finds the row under a point from variable row heights", () => {
    const heights = [rowHeight(1), rowHeight(3), rowHeight(0)];
    const tops = rowOffsets(heights);
    expect(tops).toEqual([0, heights[0], heights[0] + heights[1]]);
    expect(rowAt(tops, heights, 0)).toBe(0);
    expect(rowAt(tops, heights, heights[0] + 1)).toBe(1);
    expect(rowAt(tops, heights, tops[2] + heights[2] + 5)).toBe(-1);
    expect(rowHeight(0)).toBe(rowHeight(1)); // an empty row is still a drop target
  });

  it("clamps the column to the grid", () => {
    expect(columnAt(-10, 100, 7)).toBe(0);
    expect(columnAt(250, 100, 7)).toBe(2);
    expect(columnAt(5000, 100, 7)).toBe(6);
    expect(columnAt(10, 100, 0)).toBe(-1);
  });
});

describe("Day timeline", () => {
  const day = (start: string, end: string) => ({ dateKey: "2026-10-21", startIso: at("2026-10-21", start), endIso: at("2026-10-21", end) });

  it("shows 6:00–19:00, widened to fit early and late work", () => {
    expect(dayTimelineHours([], "2026-10-21")).toEqual({ startHour: 6, endHour: 19 });
    expect(dayTimelineHours([day("05:30", "20:15")], "2026-10-21")).toEqual({ startHour: 5, endHour: 21 });
  });

  it("places a block by its hours and never narrower than a touch target", () => {
    const range = { startHour: 6, endHour: 19 };
    expect(dayBlockGeometry(day("07:00", "15:30"), range)).toEqual({ left: HOUR_WIDTH, width: 8.5 * HOUR_WIDTH });
    const tiny = dayBlockGeometry(day("09:00", "09:10"), range);
    expect(tiny.width).toBeGreaterThanOrEqual(MIN_TOUCH);
    const startOnly = dayBlockGeometry(day("09:00", "09:00"), range);
    expect(startOnly.width).toBe(MIN_TOUCH);
  });

  it("packs overlapping blocks into lanes, and reuses a lane once it is free", () => {
    const { lane, lanes } = packLanes([
      { id: "a", left: 0, width: 100 },
      { id: "b", left: 50, width: 100 },
      { id: "c", left: 100, width: 50 },
    ]);
    expect(lanes).toBe(2);
    expect(lane.get("a")).toBe(0);
    expect(lane.get("b")).toBe(1);
    expect(lane.get("c")).toBe(0);
  });
});

describe("names on tiles", () => {
  it("initials when narrow, first name otherwise", () => {
    expect(initials("Dave  Smith")).toBe("DS");
    expect(techShortLabel("Dave Smith", true)).toBe("DS");
    expect(techShortLabel("Dave Smith", false)).toBe("Dave");
    expect(techShortLabel(null, false)).toBe("—");
  });

  it("counts the OTHER technicians on the same job that day, once each", () => {
    const mine = booking({ id: "b1", daily: true, ends_at: at("2026-10-21", "15:30") }); // Mon–Wed
    const all = [
      mine,
      booking({ id: "b2", staff_id: "sam", starts_at: at("2026-10-20", "07:00"), ends_at: at("2026-10-20", "12:00") }), // Tue
      booking({ id: "b3", staff_id: "sam", starts_at: at("2026-10-20", "13:00"), ends_at: at("2026-10-20", "15:00") }), // Tue again
      booking({ id: "b4", staff_id: null, starts_at: at("2026-10-20", "07:00") }), // unassigned — not a person
      booking({ id: "b5", job_id: "other", staff_id: "kim", starts_at: at("2026-10-20", "07:00") }), // another job
    ];
    const days = daysByBooking(all);
    const tuesday = days.get("b1")!.find((d) => d.dateKey === "2026-10-20")!;
    const monday = days.get("b1")!.find((d) => d.dateKey === "2026-10-19")!;
    expect(othersOnJobDay({ booking: mine, day: tuesday }, all, days)).toEqual(["sam"]);
    expect(othersOnJobDay({ booking: mine, day: monday }, all, days)).toEqual([]);
  });
});

describe("rows", () => {
  it("Unassigned first, busiest next, and a booked person missing from the staff list still gets a row", () => {
    const rows = gridRows(
      [
        { id: "amy", full_name: "Amy" },
        { id: "dave", full_name: "Dave" },
      ],
      ["dave", "ghost"],
      new Map([["dave", 8], ["ghost", 2]]),
      new Map([["ghost", "Old Tech"]]),
    );
    expect(rows.map((r) => r.staffId)).toEqual([null, "dave", "ghost", "amy"]);
    expect(rows[2].name).toBe("Old Tech");
  });
});

describe("what may move", () => {
  it("refuses completed jobs and stand-in bookings", () => {
    expect(moveBlockedReason({ status: "completed" }, { id: "b1" })).toMatch(/completed/);
    expect(moveBlockedReason({ status: "scheduled" }, { id: "legacy:j1" })).toMatch(/Reschedule/);
    expect(moveBlockedReason({ status: "in_progress" }, { id: "b1" })).toBeNull();
  });

  it("stands in for jobs with no bookings, under the primary assignee", () => {
    const jobs = [job(), job({ id: "j2", assigned_to: null })];
    const stand = legacyBookingsFor(jobs, [{ job_id: "j1" }]);
    expect(stand).toHaveLength(1);
    expect(stand[0]).toMatchObject({ id: "legacy:j2", job_id: "j2", staff_id: null });
  });

  it("a completed job's booking still lands on the grid (drawn greyed)", () => {
    const b = booking({ id: "b1" });
    const index = buildBoardIndex([b], new Map([["j1", job({ status: "completed" })]]), ["2026-10-19"], daysByBooking([b]));
    expect(index.byStaff.get("dave")?.get("2026-10-19")?.[0].job.status).toBe("completed");
  });
});

describe("resize by whole days", () => {
  it("stretches a one-day block into a daily booking keeping its hours", () => {
    const b = booking({ id: "b1" });
    expect(canResizeByDays(b)).toBe(true);
    const patch = planResize(b, "2026-10-21")!;
    expect(patch).toEqual({ ends_at: at("2026-10-21", "15:30"), daily: true });
    const days = scheduleDays(bookingWindow({ ...b, ...patch }));
    expect(days.map((d) => d.dateKey)).toEqual(["2026-10-19", "2026-10-20", "2026-10-21"]);
    expect(days[2].startIso).toBe(at("2026-10-21", "07:00"));
  });

  it("shrinks a daily booking, never before its first day", () => {
    const b = booking({ id: "b1", daily: true, ends_at: at("2026-10-23", "15:30") });
    expect(planResize(b, "2026-10-20")).toEqual({ ends_at: at("2026-10-20", "15:30"), daily: true });
    expect(planResize(b, "2026-10-18")).toBeNull();
    expect(planResize(b, "2026-10-23")).toBeNull(); // unchanged
  });

  it("leaves start-only and overnight blocks alone", () => {
    expect(planResize(booking({ id: "b1", ends_at: null }), "2026-10-21")).toBeNull();
    const overnight = booking({ id: "b2", starts_at: at("2026-10-19", "22:00"), ends_at: at("2026-10-20", "02:00") });
    expect(canResizeByDays(overnight)).toBe(false);
  });
});

describe("clashes", () => {
  const dave1 = booking({ id: "b1" }); // Mon 7:00–15:30
  const dave2 = booking({ id: "b2", job_id: "j2", starts_at: at("2026-10-20", "09:00"), ends_at: at("2026-10-20", "11:00") }); // Tue
  const sam = booking({ id: "b3", job_id: "j3", staff_id: "sam", starts_at: at("2026-10-20", "07:00"), ends_at: at("2026-10-20", "15:30") });

  it("warns when a move puts a technician on two jobs at once", () => {
    const patch = planBoardMove(sam, { staffId: "sam", dateKey: "2026-10-20" }, { staffId: "dave", dateKey: "2026-10-20" })!;
    const after = { ...sam, ...patch };
    expect(bookingClashes(after, [dave1, dave2, sam]).map((c) => c.booking.id)).toEqual(["b2"]);
  });

  it("is quiet for back-to-back work, another technician, or Unassigned", () => {
    const after = booking({ id: "b4", job_id: "j4", starts_at: at("2026-10-19", "15:30"), ends_at: at("2026-10-19", "17:00") });
    expect(bookingClashes(after, [dave1, dave2])).toEqual([]);
    expect(bookingClashes({ ...sam }, [dave1, dave2])).toEqual([]);
    expect(bookingClashes({ ...dave2, staff_id: null }, [dave1, dave2])).toEqual([]);
  });

  it("checks every day of a stretched booking", () => {
    const stretched = { ...dave1, ...planResize(dave1, "2026-10-21")! };
    expect(bookingClashes(stretched, [stretched, dave2]).map((c) => c.dateKey)).toEqual(["2026-10-20"]);
  });
});
