// lib/todoBoard.ts is the web's lib/todo-board.ts, pinned identical below the
// imports by tests/unit/todo-board-mirror.test.ts (the web suite tests the
// rules in full). These check the copy runs against the PHONE's own
// scheduling / bookings / date modules and gives the web's answers.
import { describeDragOut, jobPatchAfterDrop, newBookingClashes, planDragOut, planTodoDrop, unbookedHours } from "./todoBoard";
import { fitsGap, parseGapHours, sortTodoJobs, todoHours } from "./todoList";

describe("todoBoard on the phone", () => {
  it("books a to-do job with no estimate All day, a short one after the technician's last booking", () => {
    const allDay = planTodoDrop({ jobId: "j", staffId: "dave", dateKey: "2026-11-19", estimateHours: null });
    expect(allDay).toMatchObject({ job_id: "j", staff_id: "dave", cost_center_id: null, all_day: true, daily: false });
    expect(allDay.starts_at).toBe("2026-11-18T20:00:00.000Z"); // 07:00 Melbourne (UTC+11)
    expect(allDay.ends_at).toBe("2026-11-19T04:30:00.000Z"); // 15:30

    const short = planTodoDrop({
      jobId: "j",
      staffId: "dave",
      dateKey: "2026-11-19",
      estimateHours: 2,
      dayBlocks: [{ dateKey: "2026-11-19", endIso: "2026-11-18T23:10:00.000Z" }], // ends 10:10
    });
    expect(short).toMatchObject({ all_day: false, starts_at: "2026-11-18T23:15:00.000Z", ends_at: "2026-11-19T01:15:00.000Z" });
  });

  it("asks before double-booking, never for Unassigned", () => {
    const insert = planTodoDrop({ jobId: "j", staffId: "dave", dateKey: "2026-11-19", estimateHours: null });
    const other = { id: "b1", job_id: "k", staff_id: "dave", starts_at: "2026-11-18T22:00:00.000Z", ends_at: "2026-11-19T00:00:00.000Z", daily: false, all_day: false };
    expect(newBookingClashes(insert, [other]).map((b) => b.id)).toEqual(["b1"]);
    expect(newBookingClashes({ ...insert, staff_id: null }, [other])).toEqual([]);
  });

  it("takes a booking back to the list the web's way", () => {
    const b = { id: "b1", job_id: "j" };
    expect(planDragOut(b, [b], "scheduled")).toEqual({ kind: "list", status: "pending" });
    expect(planDragOut(b, [b, { id: "b2", job_id: "j" }], "scheduled")).toEqual({ kind: "remove", reason: "other-bookings", otherBookings: 1 });
    expect(planDragOut(b, [b], "in_progress")).toEqual({ kind: "remove", reason: "in-progress", otherBookings: 0 });
    expect(planDragOut(b, [b], "completed").kind).toBe("refuse");
    expect(describeDragOut({ kind: "list", status: "pending" }, { jobNumber: 123, who: "Dave", when: "Thursday" }).title).toBe(
      "Take #123 off Dave's Thursday and put it back on the to-do list?",
    );
    expect(jobPatchAfterDrop("pending")).toEqual({ todo_listed_at: null, todo_listed_by: null, status: "scheduled" });
    expect(jobPatchAfterDrop("on_hold")).toEqual({ todo_listed_at: null, todo_listed_by: null });
  });

  it("counts free hours: leave is unavailable, weekends and past days have none", () => {
    expect(unbookedHours({ dateKey: "2026-11-19", todayKey: "2026-11-19", bookedHours: 5 })).toEqual({ kind: "free", hours: 3 });
    expect(unbookedHours({ dateKey: "2026-11-19", todayKey: "2026-11-19", bookedHours: 8.5 })).toEqual({ kind: "free", hours: 0 });
    expect(unbookedHours({ dateKey: "2026-11-19", todayKey: "2026-11-19", bookedHours: 0, leaveDays: [{ fullDay: true, hours: 7.6 }] })).toEqual({ kind: "unavailable" });
    expect(unbookedHours({ dateKey: "2026-11-21", todayKey: "2026-11-19", bookedHours: 0 })).toEqual({ kind: "none" });
    expect(unbookedHours({ dateKey: "2026-11-18", todayKey: "2026-11-19", bookedHours: 0 })).toEqual({ kind: "none" });
  });

  it("todoList: estimate before PO hours, Fits-in keeps unestimated jobs, urgent first", () => {
    expect(todoHours(null, 6)).toEqual({ hours: 6, source: "po" });
    expect(todoHours("3", 6)).toEqual({ hours: 3, source: "estimate" });
    expect(fitsGap(null, parseGapHours("3"))).toBe(true);
    expect(fitsGap(4, parseGapHours("3"))).toBe(false);
    const sorted = sortTodoJobs([
      { id: "a", priority: "normal", todo_listed_at: "2026-11-01T00:00:00Z" },
      { id: "b", priority: "urgent", todo_listed_at: "2026-11-10T00:00:00Z" },
    ]);
    expect(sorted.map((j) => j.id)).toEqual(["b", "a"]);
  });
});
