import { describe, it, expect } from "vitest";
import { swapCrewMember } from "@/lib/schedule-dispatch";
import {
  applyBoardMove,
  buildBoardIndex,
  columnId,
  crewFromRow,
  dayOfLabel,
  daysByJob,
  formatHours,
  parseBoardTarget,
  planBoardMove,
  planBoardAdd,
  totalHours,
  weekCellId,
  type BoardJob,
} from "@/components/schedule/board-model";
import { fromBusinessInputValue } from "@/lib/date";

// ============================================================================
// The schedule board's move rules (components/schedule/board-model.ts and
// swapCrewMember in lib/schedule-dispatch.ts). Drag-and-drop and double-click
// cut & paste both resolve through these, in both the Day and Week views.
//
// The defect they replace: a Day-view drop wrote `assigned_to` alone, which
// the 0059 trigger turns into "only this technician" — dragging one member of
// a crew silently dropped everyone else. A move is now a SWAP of the source
// row's technician for the target row's, written via set_job_assignments.
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
    scheduled_start: at("2026-10-21", "09:00"),
    scheduled_end: at("2026-10-21", "12:00"),
    schedule_daily: false,
    assigned_to: "alice",
    crew: ["alice"],
    ...overrides,
  };
}

// Mon–Wed, 7:00–15:30 each day.
const monToWed = () =>
  job({
    scheduled_start: at("2026-10-19", "07:00"),
    scheduled_end: at("2026-10-21", "15:30"),
    schedule_daily: true,
    crew: ["alice", "bob"],
  });

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

describe("planBoardAdd — Shift-drop adds a technician instead of swapping", () => {
  it("adds the target technician to the existing crew and leaves the dates alone", () => {
    const plan = planBoardAdd(monToWed(), { staffId: "dan", dateKey: "2026-10-26" });
    expect(plan).toEqual({ crew: [...monToWed().crew, "dan"], dates: null });
  });

  it("does nothing for someone already on the crew", () => {
    const j = monToWed();
    expect(planBoardAdd(j, { staffId: j.crew[0], dateKey: "2026-10-20" })).toBeNull();
  });

  it("does nothing when dropped on Unassigned", () => {
    expect(planBoardAdd(monToWed(), { staffId: null, dateKey: "2026-10-20" })).toBeNull();
  });
});

describe("planBoardMove", () => {
  it("is null when a job goes back where it came from", () => {
    const cell = { staffId: "alice", dateKey: "2026-10-21" };
    expect(planBoardMove(job(), cell, cell)).toBeNull();
  });

  it("a same-day move between technicians changes the crew only", () => {
    const plan = planBoardMove(monToWed(), { staffId: "bob", dateKey: "2026-10-20" }, { staffId: "cara", dateKey: "2026-10-20" });
    // Moving Tuesday's chip of a Mon–Wed job must NOT restart the job on Tuesday.
    expect(plan).toEqual({ crew: ["alice", "cara"], dates: null });
  });

  it("a block moved to another day keeps its time of day and length", () => {
    const plan = planBoardMove(job(), { staffId: "alice", dateKey: "2026-10-21" }, { staffId: "alice", dateKey: "2026-10-23" });
    expect(plan?.crew).toBeNull();
    expect(plan?.dates).toEqual({ scheduled_start: at("2026-10-23", "09:00"), scheduled_end: at("2026-10-23", "12:00") });
  });

  it("a daily job starts on the target day and keeps its number of booked days, skipping the weekend", () => {
    const plan = planBoardMove(monToWed(), { staffId: "alice", dateKey: "2026-10-19" }, { staffId: "alice", dateKey: "2026-10-22" });
    expect(plan?.dates).toEqual({ scheduled_start: at("2026-10-22", "07:00"), scheduled_end: at("2026-10-26", "15:30") });
  });

  it("moves dates and swaps the crew in one go", () => {
    const plan = planBoardMove(monToWed(), { staffId: "alice", dateKey: "2026-10-19" }, { staffId: "dan", dateKey: "2026-10-26" });
    expect(plan?.crew).toEqual(["dan", "bob"]);
    expect(plan?.dates?.scheduled_start).toBe(at("2026-10-26", "07:00"));
  });

  it("keeps a start-only job start-only", () => {
    const plan = planBoardMove(job({ scheduled_end: null }), { staffId: "alice", dateKey: "2026-10-21" }, { staffId: "alice", dateKey: "2026-10-22" });
    expect(plan?.dates).toEqual({ scheduled_start: at("2026-10-22", "09:00"), scheduled_end: null });
  });

  it("applyBoardMove gives the optimistic job its new crew and window", () => {
    const original = monToWed();
    const plan = planBoardMove(original, { staffId: "alice", dateKey: "2026-10-19" }, { staffId: "dan", dateKey: "2026-10-26" })!;
    const moved = applyBoardMove(original, plan);
    expect(moved.crew).toEqual(["dan", "bob"]);
    expect(moved.assigned_to).toBe("dan");
    expect(moved.scheduled_start).toBe(plan.dates!.scheduled_start);
    expect(original.crew).toEqual(["alice", "bob"]); // not mutated — the rollback copy
  });
});

describe("buildBoardIndex", () => {
  const week = ["2026-10-19", "2026-10-20", "2026-10-21", "2026-10-22", "2026-10-23", "2026-10-24", "2026-10-25"];

  it("shows a multi-day crew job in every crew member's row on every booked day", () => {
    const jobs = [monToWed()];
    const board = buildBoardIndex(jobs, week, daysByJob(jobs));
    for (const staffId of ["alice", "bob"]) {
      expect([...board.byStaff.get(staffId)!.keys()]).toEqual(["2026-10-19", "2026-10-20", "2026-10-21"]);
    }
    const tuesday = board.byStaff.get("bob")!.get("2026-10-20")![0];
    expect(dayOfLabel(tuesday)).toBe("Day 2 of 3");
    expect(tuesday.day.startIso).toBe(at("2026-10-20", "07:00"));
  });

  it("totals booked hours per technician per day", () => {
    const jobs = [monToWed(), job({ id: "job-2", crew: ["alice"] })];
    const board = buildBoardIndex(jobs, week, daysByJob(jobs));
    expect(board.hours.get("alice")!.get("2026-10-21")).toBe(11.5); // 8.5 + 3
    expect(board.hours.get("bob")!.get("2026-10-21")).toBe(8.5);
    expect(totalHours(board.hours.get("alice"))).toBe(28.5);
    expect(formatHours(8.5)).toBe("8.5 h");
    expect(formatHours(7.75)).toBe("7.75 h");
    expect(formatHours(16)).toBe("16 h");
  });

  it("puts a job with no crew on the Unassigned row, and only the visible days", () => {
    const jobs = [job({ crew: [], assigned_to: null })];
    const board = buildBoardIndex(jobs, ["2026-10-21"], daysByJob(jobs));
    expect(board.unassigned.get("2026-10-21")).toHaveLength(1);
    expect(board.byStaff.size).toBe(0);
    expect(buildBoardIndex(jobs, ["2026-10-22"], daysByJob(jobs)).unassigned.size).toBe(0);
  });

  it("a one-day job has no Day-of label", () => {
    const jobs = [job()];
    const entry = buildBoardIndex(jobs, week, daysByJob(jobs)).byStaff.get("alice")!.get("2026-10-21")![0];
    expect(dayOfLabel(entry)).toBeNull();
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
