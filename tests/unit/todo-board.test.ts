import { describe, it, expect } from "vitest";
import {
  STANDARD_DAY_HOURS,
  canAddToTodo,
  describeDragOut,
  jobNumberQuery,
  jobPatchAfterDrop,
  newBookingClashes,
  planDragOut,
  planTodoDrop,
  todoDragId,
  todoJobIdFromDragId,
  unbookedHours,
} from "@/lib/todo-board";
import { fromBusinessInputValue, toBusinessInputValue } from "@/lib/date";

// 2026-11-19 is a Thursday; 2026-11-21 a Saturday.
const THU = "2026-11-19";
const SAT = "2026-11-21";
const at = (dateKey: string, hhmm: string) => fromBusinessInputValue(`${dateKey}T${hhmm}`);
const wall = (iso: string | null) => (iso ? toBusinessInputValue(iso).slice(11, 16) : null);

describe("unbookedHours — the gap the to-do list fills", () => {
  it("a standard day less what is booked", () => {
    expect(unbookedHours({ dateKey: THU, todayKey: THU, bookedHours: 3 })).toEqual({ kind: "free", hours: 5 });
    expect(unbookedHours({ dateKey: THU, todayKey: THU, bookedHours: 0 })).toEqual({ kind: "free", hours: STANDARD_DAY_HOURS });
  });

  it("never negative — an all-day booking (8.5 h incl. break) leaves 0", () => {
    expect(unbookedHours({ dateKey: THU, todayKey: THU, bookedHours: 8.5 })).toEqual({ kind: "free", hours: 0 });
    expect(unbookedHours({ dateKey: THU, todayKey: THU, bookedHours: 11 })).toEqual({ kind: "free", hours: 0 });
  });

  it("a full leave day is unavailable, not unbooked", () => {
    expect(unbookedHours({ dateKey: THU, todayKey: THU, bookedHours: 0, leaveDays: [{ fullDay: true, hours: 7.6 }] })).toEqual({ kind: "unavailable" });
  });

  it("a part day of unknown hours is unavailable; known hours come off the day", () => {
    expect(unbookedHours({ dateKey: THU, todayKey: THU, bookedHours: 0, leaveDays: [{ fullDay: false, hours: null }] })).toEqual({ kind: "unavailable" });
    expect(unbookedHours({ dateKey: THU, todayKey: THU, bookedHours: 2, leaveDays: [{ fullDay: false, hours: 4 }] })).toEqual({ kind: "free", hours: 2 });
  });

  it("no gap on weekends or past days", () => {
    expect(unbookedHours({ dateKey: SAT, todayKey: THU, bookedHours: 0 })).toEqual({ kind: "none" });
    expect(unbookedHours({ dateKey: "2026-11-18", todayKey: THU, bookedHours: 0 })).toEqual({ kind: "none" });
  });
});

describe("planTodoDrop — a to-do job dropped on a day", () => {
  it("no estimate: one all-day booking (7:00–15:30) for that technician, no cost centre", () => {
    const b = planTodoDrop({ jobId: "j1", staffId: "dave", dateKey: THU, estimateHours: null });
    expect(b).toMatchObject({ job_id: "j1", staff_id: "dave", cost_center_id: null, daily: false, all_day: true });
    expect(b.starts_at).toBe(at(THU, "07:00"));
    expect(b.ends_at).toBe(at(THU, "15:30"));
  });

  it("an estimate of a full day or more is still one all-day booking (no invented multi-day)", () => {
    const b = planTodoDrop({ jobId: "j1", staffId: "dave", dateKey: THU, estimateHours: 24 });
    expect(b.all_day).toBe(true);
    expect(b.daily).toBe(false);
  });

  it("a shorter estimate books that many hours from 7:00, rounded up to the quarter hour", () => {
    const b = planTodoDrop({ jobId: "j1", staffId: "dave", dateKey: THU, estimateHours: 2.1 });
    expect(b.all_day).toBe(false);
    expect([wall(b.starts_at), wall(b.ends_at)]).toEqual(["07:00", "09:15"]);
  });

  it("starts straight after the technician's last booking that day, filling the gap", () => {
    const b = planTodoDrop({
      jobId: "j1",
      staffId: "dave",
      dateKey: THU,
      estimateHours: 3,
      dayBlocks: [
        { dateKey: THU, endIso: at(THU, "10:00") },
        { dateKey: THU, endIso: at(THU, "11:20") },
        { dateKey: "2026-11-20", endIso: at("2026-11-20", "14:00") },
      ],
    });
    expect([wall(b.starts_at), wall(b.ends_at)]).toEqual(["11:30", "14:30"]);
  });

  it("a day already booked past 15:30 falls back to 7:00 (the clash check then asks)", () => {
    const b = planTodoDrop({ jobId: "j1", staffId: "dave", dateKey: THU, estimateHours: 2, dayBlocks: [{ dateKey: THU, endIso: at(THU, "16:00") }] });
    expect(wall(b.starts_at)).toBe("07:00");
  });

  it("Unassigned: staff_id null", () => {
    expect(planTodoDrop({ jobId: "j1", staffId: null, dateKey: THU, estimateHours: null }).staff_id).toBeNull();
  });
});

describe("newBookingClashes", () => {
  const allDay = { id: "b1", job_id: "j9", staff_id: "dave", starts_at: at(THU, "07:00"), ends_at: at(THU, "15:30"), daily: false, all_day: true };
  const afternoon = { id: "b2", job_id: "j8", staff_id: "dave", starts_at: at(THU, "13:00"), ends_at: at(THU, "15:00"), daily: false, all_day: false };
  const sams = { ...allDay, id: "b3", staff_id: "sam" };

  it("finds the same technician's overlapping bookings only", () => {
    const morning = planTodoDrop({ jobId: "j1", staffId: "dave", dateKey: THU, estimateHours: 2 });
    expect(newBookingClashes(morning, [allDay, afternoon, sams]).map((b) => b.id)).toEqual(["b1"]);
  });

  it("a morning block and an afternoon booking don't clash", () => {
    const morning = planTodoDrop({ jobId: "j1", staffId: "dave", dateKey: THU, estimateHours: 2 });
    expect(newBookingClashes(morning, [afternoon])).toEqual([]);
  });

  it("Unassigned never clashes", () => {
    expect(newBookingClashes(planTodoDrop({ jobId: "j1", staffId: null, dateKey: THU, estimateHours: null }), [allDay])).toEqual([]);
  });
});

describe("jobPatchAfterDrop", () => {
  it("takes the job off the list; a pending job becomes scheduled", () => {
    expect(jobPatchAfterDrop("pending")).toEqual({ todo_listed_at: null, todo_listed_by: null, status: "scheduled" });
  });
  it("leaves any other status alone", () => {
    expect(jobPatchAfterDrop("on_hold")).toEqual({ todo_listed_at: null, todo_listed_by: null });
  });
});

describe("planDragOut — a booking dropped on the to-do list", () => {
  const b1 = { id: "b1", job_id: "j1" };
  const b2 = { id: "b2", job_id: "j1" };
  const other = { id: "x", job_id: "j2" };

  it("the job's last booking: list it, a scheduled job goes back to pending", () => {
    expect(planDragOut(b1, [b1, other], "scheduled")).toEqual({ kind: "list", status: "pending" });
  });

  it("pending / on hold keep their status", () => {
    expect(planDragOut(b1, [b1], "pending")).toEqual({ kind: "list" });
    expect(planDragOut(b1, [b1], "on_hold")).toEqual({ kind: "list" });
  });

  it("other bookings remain: remove only this one, don't list", () => {
    expect(planDragOut(b1, [b1, b2, other], "scheduled")).toEqual({ kind: "remove", reason: "other-bookings", otherBookings: 1 });
  });

  it("in progress: remove the booking, never list", () => {
    expect(planDragOut(b1, [b1], "in_progress")).toEqual({ kind: "remove", reason: "in-progress", otherBookings: 0 });
  });

  it("refuses closed jobs and unsaved bookings", () => {
    expect(planDragOut(b1, [b1], "completed").kind).toBe("refuse");
    expect(planDragOut({ id: "pending:x", job_id: "j1" }, [], "scheduled").kind).toBe("refuse");
  });

  it("says what it will do", () => {
    const list = describeDragOut({ kind: "list", status: "pending" }, { jobNumber: 123, who: "Dave", when: "Thursday" });
    expect(list.title).toBe("Take #123 off Dave's Thursday and put it back on the to-do list?");
    expect(list.detail).toMatch(/Pending/);
    const remove = describeDragOut({ kind: "remove", reason: "other-bookings", otherBookings: 2 }, { jobNumber: 123, who: "Dave", when: "Thursday" });
    expect(remove.title).toBe("Take #123 off Dave's Thursday?");
    expect(remove.detail).toMatch(/2 other bookings/);
  });
});

describe("drag ids, search helpers", () => {
  it("round-trips a to-do drag id", () => {
    expect(todoJobIdFromDragId(todoDragId("abc"))).toBe("abc");
    expect(todoJobIdFromDragId("b1@staff:x::2026-11-19")).toBeNull();
  });

  it("only open, unscheduled, unlisted jobs can be added", () => {
    expect(canAddToTodo({ status: "pending", todo_listed_at: null, scheduled_start: null })).toBe(true);
    expect(canAddToTodo({ status: "on_hold", todo_listed_at: null, scheduled_start: null })).toBe(true);
    expect(canAddToTodo({ status: "scheduled", todo_listed_at: null, scheduled_start: null })).toBe(false);
    expect(canAddToTodo({ status: "pending", todo_listed_at: "2026-11-01T00:00:00Z", scheduled_start: null })).toBe(false);
    expect(canAddToTodo({ status: "pending", todo_listed_at: null, scheduled_start: at(THU, "07:00") })).toBe(false);
  });

  it("reads a job number from the search box", () => {
    expect(jobNumberQuery("#123")).toBe(123);
    expect(jobNumberQuery(" 45 ")).toBe(45);
    expect(jobNumberQuery("smith")).toBeNull();
  });
});
