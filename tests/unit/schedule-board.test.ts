import { describe, it, expect } from "vitest";
import { swapCrewMember } from "@/lib/schedule-dispatch";
import {
  applyBoardMove,
  buildBoardIndex,
  columnId,
  crewFromRow,
  dayOfLabel,
  daysByBooking,
  formatHours,
  jobDaysFromBookings,
  parseBoardTarget,
  planBoardMove,
  planBoardAdd,
  totalHours,
  weekCellId,
  type BoardBooking,
  type BoardJob,
} from "@/components/schedule/board-model";
import { fromBusinessInputValue } from "@/lib/date";

// ============================================================================
// The schedule board's rules (components/schedule/board-model.ts). Drag-and-
// drop and double-click cut & paste both resolve through these, in both the
// Day and Week views.
//
// The board draws BOOKINGS (job_bookings — migration 0079, a draft not
// applied yet): each technician's own time on a job. A move changes the one
// booking dragged; Shift adds a copy for the target technician. Before
// bookings a move swapped crew members on a job whose single window was
// repeated in every crew row, so a pair on different days could not be drawn.
//
// Calendar (Melbourne): Mon 19 Oct 2026 … Fri 23, Sat 24, Sun 25, Mon 26.
// ============================================================================

const at = (key: string, time: string) => fromBusinessInputValue(`${key}T${time}`);

function job(overrides: Partial<BoardJob> = {}): BoardJob {
  return {
    id: "job-1",
    job_number: 123,
    title: "Hot water",
    status: "scheduled",
    scheduled_start: at("2026-10-19", "07:00"),
    scheduled_end: at("2026-10-22", "15:30"),
    assigned_to: "alice",
    crew: ["alice", "bob"],
    ...overrides,
  };
}

function booking(overrides: Partial<BoardBooking> = {}): BoardBooking {
  return {
    id: "b-1",
    job_id: "job-1",
    staff_id: "alice",
    cost_center_id: "cc-rough",
    starts_at: at("2026-10-21", "09:00"),
    ends_at: at("2026-10-21", "12:00"),
    daily: false,
    all_day: false,
    ...overrides,
  };
}

// Alice: rough-in Mon–Wed, all day.
const aliceMonToWed = () =>
  booking({
    id: "b-alice",
    starts_at: at("2026-10-19", "07:00"),
    ends_at: at("2026-10-21", "15:30"),
    daily: true,
    all_day: true,
  });

// Bob: rough-in Monday morning only.
const bobMonMorning = () =>
  booking({ id: "b-bob", staff_id: "bob", starts_at: at("2026-10-19", "07:00"), ends_at: at("2026-10-19", "11:00") });

// Alice again: fit-off Thursday.
const aliceThuFitOff = () =>
  booking({ id: "b-alice-2", cost_center_id: "cc-fit", starts_at: at("2026-10-22", "08:00"), ends_at: at("2026-10-22", "15:30") });

describe("swapCrewMember", () => {
  it("swaps the source technician for the target and keeps the rest of the crew", () => {
    expect(swapCrewMember(["alice", "bob", "cara"], "bob", "dan")).toEqual(["alice", "dan", "cara"]);
  });

  it("only removes the source when the target is already on the crew", () => {
    expect(swapCrewMember(["alice", "bob"], "alice", "bob")).toEqual(["bob"]);
  });

  it("adds the target when the job came from the Unassigned row", () => {
    expect(swapCrewMember([], null, "alice")).toEqual(["alice"]);
  });

  it("removes the source when the job is put on the Unassigned row", () => {
    expect(swapCrewMember(["alice", "bob"], "alice", null)).toEqual(["bob"]);
    expect(swapCrewMember(["alice"], "alice", null)).toEqual([]);
  });

  it("leaves the crew alone when source and target are the same row", () => {
    expect(swapCrewMember(["alice", "bob"], "bob", "bob")).toEqual(["alice", "bob"]);
    expect(swapCrewMember([], null, null)).toEqual([]);
  });

  it("still adds the target if the source has already left the crew", () => {
    expect(swapCrewMember(["bob"], "alice", "cara")).toEqual(["bob", "cara"]);
  });
});

describe("parseBoardTarget", () => {
  it("reads a Day-view column as that technician on the shown day", () => {
    expect(parseBoardTarget(columnId("alice"), "2026-10-21")).toEqual({ staffId: "alice", dateKey: "2026-10-21" });
    expect(parseBoardTarget(columnId(null), "2026-10-21")).toEqual({ staffId: null, dateKey: "2026-10-21" });
  });

  it("reads a Week-view cell's own day, not the shown day", () => {
    expect(parseBoardTarget(weekCellId("alice", "2026-10-23"), "2026-10-19")).toEqual({ staffId: "alice", dateKey: "2026-10-23" });
    expect(parseBoardTarget(weekCellId(null, "2026-10-23"), "2026-10-19")).toEqual({ staffId: null, dateKey: "2026-10-23" });
  });

  it("rejects ids that are not board cells", () => {
    expect(parseBoardTarget("staff:", "2026-10-21")).toBeNull();
    expect(parseBoardTarget("something-else", "2026-10-21")).toBeNull();
    expect(parseBoardTarget("staff:alice::not-a-date", "2026-10-21")).toBeNull();
  });
});

describe("planBoardMove — a move changes the ONE booking dragged", () => {
  it("is null when a booking goes back where it came from", () => {
    const cell = { staffId: "alice", dateKey: "2026-10-21" };
    expect(planBoardMove(booking(), cell, cell)).toBeNull();
  });

  it("a same-day move between technicians hands the booking over, dates untouched", () => {
    const plan = planBoardMove(aliceMonToWed(), { staffId: "alice", dateKey: "2026-10-20" }, { staffId: "cara", dateKey: "2026-10-20" });
    // Moving Tuesday's chip of a Mon–Wed booking must NOT restart it on Tuesday.
    expect(plan).toEqual({ staff_id: "cara" });
  });

  it("onto Unassigned unassigns the booking", () => {
    expect(planBoardMove(booking(), { staffId: "alice", dateKey: "2026-10-21" }, { staffId: null, dateKey: "2026-10-21" })).toEqual({
      staff_id: null,
    });
  });

  it("a block moved to another day keeps its time of day and length", () => {
    const plan = planBoardMove(booking(), { staffId: "alice", dateKey: "2026-10-21" }, { staffId: "alice", dateKey: "2026-10-23" });
    expect(plan).toEqual({ starts_at: at("2026-10-23", "09:00"), ends_at: at("2026-10-23", "12:00") });
  });

  it("a daily booking starts on the target day and keeps its number of booked days, skipping the weekend", () => {
    const plan = planBoardMove(aliceMonToWed(), { staffId: "alice", dateKey: "2026-10-19" }, { staffId: "alice", dateKey: "2026-10-22" });
    expect(plan).toEqual({ starts_at: at("2026-10-22", "07:00"), ends_at: at("2026-10-26", "15:30") });
  });

  it("moves technician and dates in one go", () => {
    const plan = planBoardMove(aliceMonToWed(), { staffId: "alice", dateKey: "2026-10-19" }, { staffId: "dan", dateKey: "2026-10-26" });
    expect(plan?.staff_id).toBe("dan");
    expect(plan?.starts_at).toBe(at("2026-10-26", "07:00"));
  });

  it("keeps a start-only booking start-only", () => {
    const plan = planBoardMove(booking({ ends_at: null }), { staffId: "alice", dateKey: "2026-10-21" }, { staffId: "alice", dateKey: "2026-10-22" });
    expect(plan).toEqual({ starts_at: at("2026-10-22", "09:00"), ends_at: null });
  });

  it("applyBoardMove gives the optimistic booking its new technician and window without mutating the original", () => {
    const original = aliceMonToWed();
    const plan = planBoardMove(original, { staffId: "alice", dateKey: "2026-10-19" }, { staffId: "dan", dateKey: "2026-10-26" })!;
    const moved = applyBoardMove(original, plan);
    expect(moved.staff_id).toBe("dan");
    expect(moved.starts_at).toBe(plan.starts_at);
    expect(moved.cost_center_id).toBe("cc-rough");
    expect(original.staff_id).toBe("alice"); // the rollback copy
  });
});

describe("planBoardAdd — Shift-drop books the target technician as well", () => {
  it("copies the booking's window and cost centre for the target technician", () => {
    const b = aliceMonToWed();
    const copy = planBoardAdd(b, { staffId: "alice", dateKey: "2026-10-20" }, { staffId: "dan", dateKey: "2026-10-20" }, [b]);
    expect(copy).toEqual({
      job_id: "job-1",
      staff_id: "dan",
      cost_center_id: "cc-rough",
      starts_at: b.starts_at,
      ends_at: b.ends_at,
      daily: true,
      all_day: true,
    });
  });

  it("dropped on another day (Week view), the copy starts there with the same shape", () => {
    const b = booking();
    const copy = planBoardAdd(b, { staffId: "alice", dateKey: "2026-10-21" }, { staffId: "dan", dateKey: "2026-10-22" }, [b]);
    expect(copy).toMatchObject({ staff_id: "dan", starts_at: at("2026-10-22", "09:00"), ends_at: at("2026-10-22", "12:00") });
  });

  it("does nothing when the target already has exactly that booking", () => {
    const b = aliceMonToWed();
    const theirs = { ...b, id: "b-dan", staff_id: "dan" };
    expect(planBoardAdd(b, { staffId: "alice", dateKey: "2026-10-20" }, { staffId: "dan", dateKey: "2026-10-20" }, [b, theirs])).toBeNull();
  });

  it("still adds when the target's existing booking on the job is a different stage", () => {
    const b = aliceMonToWed();
    const other = { ...aliceThuFitOff(), staff_id: "dan" };
    expect(planBoardAdd(b, { staffId: "alice", dateKey: "2026-10-20" }, { staffId: "dan", dateKey: "2026-10-20" }, [b, other])).not.toBeNull();
  });

  it("does nothing when dropped on Unassigned", () => {
    const b = aliceMonToWed();
    expect(planBoardAdd(b, { staffId: "alice", dateKey: "2026-10-20" }, { staffId: null, dateKey: "2026-10-20" }, [b])).toBeNull();
  });
});

describe("buildBoardIndex — each technician's OWN bookings", () => {
  const week = ["2026-10-19", "2026-10-20", "2026-10-21", "2026-10-22", "2026-10-23", "2026-10-24", "2026-10-25"];
  const jobs = new Map([["job-1", job()]]);

  it("puts each booking under its own technician on its own days — not the job window under everyone", () => {
    const bookings = [aliceMonToWed(), bobMonMorning(), aliceThuFitOff()];
    const board = buildBoardIndex(bookings, jobs, week, daysByBooking(bookings));
    expect([...board.byStaff.get("alice")!.keys()]).toEqual(["2026-10-19", "2026-10-20", "2026-10-21", "2026-10-22"]);
    // Bob is on Monday only, even though the job runs to Thursday.
    expect([...board.byStaff.get("bob")!.keys()]).toEqual(["2026-10-19"]);
    const tuesday = board.byStaff.get("alice")!.get("2026-10-20")![0];
    expect(dayOfLabel(tuesday)).toBe("Day 2 of 3");
    expect(tuesday.day.startIso).toBe(at("2026-10-20", "07:00"));
    expect(tuesday.booking.id).toBe("b-alice");
    // Thursday's card is the fit-off booking, a one-day block.
    const thursday = board.byStaff.get("alice")!.get("2026-10-22")![0];
    expect(thursday.booking.id).toBe("b-alice-2");
    expect(dayOfLabel(thursday)).toBeNull();
  });

  it("totals each technician's hours from their own bookings", () => {
    const bookings = [aliceMonToWed(), bobMonMorning(), aliceThuFitOff()];
    const board = buildBoardIndex(bookings, jobs, week, daysByBooking(bookings));
    expect(board.hours.get("alice")!.get("2026-10-19")).toBe(8.5);
    expect(board.hours.get("bob")!.get("2026-10-19")).toBe(4);
    expect(board.hours.get("alice")!.get("2026-10-22")).toBe(7.5);
    expect(totalHours(board.hours.get("alice"))).toBe(33); // 3 × 8.5 + 7.5
    expect(totalHours(board.hours.get("bob"))).toBe(4);
    expect(formatHours(8.5)).toBe("8.5 h");
    expect(formatHours(7.75)).toBe("7.75 h");
    expect(formatHours(16)).toBe("16 h");
  });

  it("adds up two bookings for one technician on the same day", () => {
    const bookings = [booking(), booking({ id: "b-2", starts_at: at("2026-10-21", "13:00"), ends_at: at("2026-10-21", "15:00") })];
    const board = buildBoardIndex(bookings, jobs, week, daysByBooking(bookings));
    expect(board.byStaff.get("alice")!.get("2026-10-21")!.map((e) => e.booking.id)).toEqual(["b-1", "b-2"]);
    expect(board.hours.get("alice")!.get("2026-10-21")).toBe(5);
  });

  it("puts an unassigned booking on the Unassigned row, and only the visible days", () => {
    const bookings = [booking({ staff_id: null })];
    const board = buildBoardIndex(bookings, jobs, ["2026-10-21"], daysByBooking(bookings));
    expect(board.unassigned.get("2026-10-21")).toHaveLength(1);
    expect(board.byStaff.size).toBe(0);
    expect(buildBoardIndex(bookings, jobs, ["2026-10-22"], daysByBooking(bookings)).unassigned.size).toBe(0);
  });

  it("leaves out a booking whose job is not on the board (completed or cancelled)", () => {
    const bookings = [booking({ job_id: "job-done" })];
    expect(buildBoardIndex(bookings, jobs, week, daysByBooking(bookings)).byStaff.size).toBe(0);
  });
});

describe("jobDaysFromBookings — the List tab's days for a job", () => {
  it("is the union of the bookings' days, earliest start to latest end per day", () => {
    const days = jobDaysFromBookings([aliceMonToWed(), bobMonMorning(), aliceThuFitOff()]);
    expect(days.map((d) => d.dateKey)).toEqual(["2026-10-19", "2026-10-20", "2026-10-21", "2026-10-22"]);
    expect(days[0]).toMatchObject({ startIso: at("2026-10-19", "07:00"), endIso: at("2026-10-19", "15:30") });
    expect(days[3]).toMatchObject({ startIso: at("2026-10-22", "08:00"), endIso: at("2026-10-22", "15:30") });
  });

  it("is empty with no bookings", () => {
    expect(jobDaysFromBookings([])).toEqual([]);
  });
});

describe("crewFromRow", () => {
  it("is the primary plus every assignment, without duplicates", () => {
    expect(crewFromRow("alice", [{ staff_id: "alice" }, { staff_id: "bob" }])).toEqual(["alice", "bob"]);
  });

  it("keeps the primary when RLS hides its assignment row", () => {
    expect(crewFromRow("alice", [{ staff_id: "bob" }])).toEqual(["alice", "bob"]);
  });

  it("is empty for an unassigned job", () => {
    expect(crewFromRow(null, [])).toEqual([]);
    expect(crewFromRow(null, null)).toEqual([]);
  });
});
