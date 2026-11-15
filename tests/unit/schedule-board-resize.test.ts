import { describe, it, expect } from "vitest";
import {
  buildResizePreviewIndex,
  daysByBooking,
  firstName,
  nameInitials,
  otherStaffOnJobDay,
  planBookingResize,
  resizeBlockedReason,
  resizeConflicts,
  type BoardBooking,
  type BoardJob,
} from "@/components/schedule/board-model";
import { scheduleDays } from "@/lib/scheduling";
import { bookingWindow } from "@/lib/bookings";
import { fromBusinessInputValue } from "@/lib/date";

// ============================================================================
// Edge resize and tile name tags on the schedule board (board-model.ts).
//
// A resize drags a booking's first or last day by whole days. What the new
// window MEANS is lib/scheduling.ts's (the Schedule dialog's own rules), so
// these tests pin the representation: same daily hours, `daily` on exactly
// when the booking spans more than one day, weekends inside skipped.
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
    crew: ["alice"],
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

const keys = (b: Pick<BoardBooking, "starts_at" | "ends_at" | "daily" | "all_day">) =>
  scheduleDays(bookingWindow(b)).map((d) => d.dateKey);

describe("planBookingResize", () => {
  it("stretches a one-day booking into a daily booking with the same hours", () => {
    const plan = planBookingResize(booking(), "end", 2);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.changed).toBe(true);
    expect(plan.window).toEqual({
      starts_at: at("2026-10-21", "09:00"),
      ends_at: at("2026-10-23", "12:00"),
      daily: true,
      all_day: false,
    });
    expect(keys(plan.window)).toEqual(["2026-10-21", "2026-10-22", "2026-10-23"]);
    expect(plan.startKey).toBe("2026-10-21");
    expect(plan.endKey).toBe("2026-10-23");
  });

  it("moves the first day earlier with the left edge", () => {
    const plan = planBookingResize(booking(), "start", -2);
    if (!plan.ok) throw new Error(plan.error);
    expect(plan.window.starts_at).toBe(at("2026-10-19", "09:00"));
    expect(plan.window.ends_at).toBe(at("2026-10-21", "12:00"));
    expect(plan.window.daily).toBe(true);
  });

  it("shortens a multi-day booking back to one day and turns daily off", () => {
    const b = booking({ starts_at: at("2026-10-19", "07:00"), ends_at: at("2026-10-21", "15:30"), daily: true, all_day: true });
    const plan = planBookingResize(b, "end", -2);
    if (!plan.ok) throw new Error(plan.error);
    expect(plan.window).toEqual({ starts_at: at("2026-10-19", "07:00"), ends_at: at("2026-10-19", "15:30"), daily: false, all_day: true });
  });

  it("stops at one day when an edge is dragged past the other", () => {
    const b = booking({ starts_at: at("2026-10-19", "07:00"), ends_at: at("2026-10-20", "15:30"), daily: true });
    const left = planBookingResize(b, "start", 5);
    const right = planBookingResize(b, "end", -5);
    if (!left.ok || !right.ok) throw new Error("expected ok");
    expect(keys(left.window)).toEqual(["2026-10-20"]);
    expect(keys(right.window)).toEqual(["2026-10-19"]);
  });

  it("skips the weekend inside the new range and books a weekend end day", () => {
    const fri = booking({ starts_at: at("2026-10-23", "07:00"), ends_at: at("2026-10-23", "15:30") });
    const toMon = planBookingResize(fri, "end", 3);
    const toSat = planBookingResize(fri, "end", 1);
    if (!toMon.ok || !toSat.ok) throw new Error("expected ok");
    expect(keys(toMon.window)).toEqual(["2026-10-23", "2026-10-26"]);
    expect(keys(toSat.window)).toEqual(["2026-10-23", "2026-10-24"]);
  });

  it("keeps the stored hours of an all-day booking rather than re-deriving them", () => {
    // all_day flagged but stored as 06:30–14:00: the hours win.
    const b = booking({ starts_at: at("2026-10-21", "06:30"), ends_at: at("2026-10-21", "14:00"), all_day: true });
    const plan = planBookingResize(b, "end", 1);
    if (!plan.ok) throw new Error(plan.error);
    expect(plan.window.ends_at).toBe(at("2026-10-22", "14:00"));
    expect(plan.window.all_day).toBe(true);
  });

  it("reports no change when dragged back to where it started", () => {
    const plan = planBookingResize(booking(), "end", 0);
    expect(plan.ok && plan.changed).toBe(false);
  });

  it("refuses a range past the schedule cap", () => {
    const plan = planBookingResize(booking(), "end", 400);
    expect(plan.ok).toBe(false);
  });
});

describe("resizeBlockedReason", () => {
  it("blocks completed and cancelled jobs", () => {
    expect(resizeBlockedReason({ status: "completed" }, booking())).toMatch(/completed/);
    expect(resizeBlockedReason({ status: "cancelled" }, booking())).toMatch(/cancelled/);
  });

  it("allows an open job's ordinary booking", () => {
    expect(resizeBlockedReason({ status: "scheduled" }, booking())).toBeNull();
    expect(resizeBlockedReason({ status: "in_progress" }, booking())).toBeNull();
  });

  it("blocks a booking still saving, a start-only booking and an overnight block", () => {
    expect(resizeBlockedReason({ status: "scheduled" }, booking({ id: "pending:x" }))).not.toBeNull();
    expect(resizeBlockedReason({ status: "scheduled" }, booking({ ends_at: null }))).not.toBeNull();
    expect(
      resizeBlockedReason({ status: "scheduled" }, booking({ starts_at: at("2026-10-21", "20:00"), ends_at: at("2026-10-22", "02:00") })),
    ).not.toBeNull();
  });
});

describe("resizeConflicts", () => {
  const jobsById = new Map([
    ["job-1", job()],
    ["job-2", job({ id: "job-2", job_number: 456, title: "Leak" })],
  ]);
  const alice = booking({ starts_at: at("2026-10-19", "07:00"), ends_at: at("2026-10-19", "15:30") });

  it("names the technician's other booking on a gained day when the hours overlap", () => {
    const other = booking({ id: "b-2", job_id: "job-2", starts_at: at("2026-10-20", "08:00"), ends_at: at("2026-10-20", "10:00") });
    const plan = planBookingResize(alice, "end", 1);
    if (!plan.ok) throw new Error(plan.error);
    const conflicts = resizeConflicts(alice, plan.window, [alice, other], jobsById);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].booking.id).toBe("b-2");
    expect(conflicts[0].job.job_number).toBe(456);
    expect(conflicts[0].days.map((d) => d.dateKey)).toEqual(["2026-10-20"]);
  });

  it("ignores a same-day booking whose hours don't overlap", () => {
    const afternoon = booking({ id: "b-2", job_id: "job-2", starts_at: at("2026-10-20", "16:00"), ends_at: at("2026-10-20", "18:00") });
    const plan = planBookingResize(alice, "end", 1);
    if (!plan.ok) throw new Error(plan.error);
    expect(resizeConflicts(alice, plan.window, [alice, afternoon], jobsById)).toEqual([]);
  });

  it("ignores other technicians, days already held, unassigned bookings and jobs off the board", () => {
    const bobTue = booking({ id: "b-bob", staff_id: "bob", job_id: "job-2", starts_at: at("2026-10-20", "07:00"), ends_at: at("2026-10-20", "15:30") });
    const aliceMonClash = booking({ id: "b-mon", job_id: "job-2", starts_at: at("2026-10-19", "08:00"), ends_at: at("2026-10-19", "09:00") });
    const offBoard = booking({ id: "b-off", job_id: "job-gone", starts_at: at("2026-10-20", "07:00"), ends_at: at("2026-10-20", "15:30") });
    const plan = planBookingResize(alice, "end", 1);
    if (!plan.ok) throw new Error(plan.error);
    expect(resizeConflicts(alice, plan.window, [alice, bobTue, aliceMonClash, offBoard], jobsById)).toEqual([]);

    const unassigned = { ...alice, staff_id: null };
    const clash = booking({ id: "b-2", staff_id: null, job_id: "job-2", starts_at: at("2026-10-20", "07:00"), ends_at: at("2026-10-20", "15:30") });
    expect(resizeConflicts(unassigned, plan.window, [unassigned, clash], jobsById)).toEqual([]);
  });

  it("counts a start-only booking that falls inside the gained hours", () => {
    const inside = booking({ id: "b-2", job_id: "job-2", starts_at: at("2026-10-20", "09:00"), ends_at: null });
    const after = booking({ id: "b-3", job_id: "job-2", starts_at: at("2026-10-20", "16:00"), ends_at: null });
    const plan = planBookingResize(alice, "end", 1);
    if (!plan.ok) throw new Error(plan.error);
    expect(resizeConflicts(alice, plan.window, [alice, inside, after], jobsById).map((c) => c.booking.id)).toEqual(["b-2"]);
  });

  it("counts the technician's other booking on the same job too", () => {
    const fitOff = booking({ id: "b-fit", starts_at: at("2026-10-20", "12:00"), ends_at: at("2026-10-20", "14:00") });
    const plan = planBookingResize(alice, "end", 1);
    if (!plan.ok) throw new Error(plan.error);
    expect(resizeConflicts(alice, plan.window, [alice, fitOff], jobsById).map((c) => c.booking.id)).toEqual(["b-fit"]);
  });
});

describe("buildResizePreviewIndex", () => {
  const jobsById = new Map([["job-1", job()]]);
  const week = ["2026-10-19", "2026-10-20", "2026-10-21", "2026-10-22", "2026-10-23", "2026-10-24", "2026-10-25"];
  const monToWed = booking({ starts_at: at("2026-10-19", "07:00"), ends_at: at("2026-10-21", "15:30"), daily: true });

  it("draws the booking on its preview days, with their hours", () => {
    const plan = planBookingResize(monToWed, "end", 2);
    if (!plan.ok) throw new Error(plan.error);
    const { index, droppedDayKeys } = buildResizePreviewIndex([monToWed], jobsById, week, daysByBooking([monToWed]), monToWed, plan.window);
    expect([...index.byStaff.get("alice")!.keys()].sort()).toEqual(["2026-10-19", "2026-10-20", "2026-10-21", "2026-10-22", "2026-10-23"]);
    expect(index.hours.get("alice")!.get("2026-10-23")).toBe(8.5);
    expect(droppedDayKeys.size).toBe(0);
  });

  it("keeps a dropped day drawn (same booking) but without hours", () => {
    const plan = planBookingResize(monToWed, "end", -1);
    if (!plan.ok) throw new Error(plan.error);
    const { index, droppedDayKeys, previewDays } = buildResizePreviewIndex([monToWed], jobsById, week, daysByBooking([monToWed]), monToWed, plan.window);
    expect(previewDays.map((d) => d.dateKey)).toEqual(["2026-10-19", "2026-10-20"]);
    expect([...droppedDayKeys]).toEqual(["2026-10-21"]);
    const wed = index.byStaff.get("alice")!.get("2026-10-21")!;
    expect(wed).toHaveLength(1);
    expect(wed[0].booking.id).toBe(monToWed.id);
    expect(index.hours.get("alice")!.get("2026-10-21")).toBeUndefined();
  });
});

describe("tile name tags", () => {
  it("lists the other technicians on the same job that day, once each, never the tile's own", () => {
    const alice = booking({ id: "a", starts_at: at("2026-10-19", "07:00"), ends_at: at("2026-10-21", "15:30"), daily: true });
    const bobMon = booking({ id: "b1", staff_id: "bob", starts_at: at("2026-10-19", "07:00"), ends_at: at("2026-10-19", "11:00") });
    const bobMon2 = booking({ id: "b2", staff_id: "bob", starts_at: at("2026-10-19", "12:00"), ends_at: at("2026-10-19", "15:00") });
    const camTue = booking({ id: "c", staff_id: "cam", starts_at: at("2026-10-20", "07:00"), ends_at: at("2026-10-20", "11:00") });
    const unassigned = booking({ id: "u", staff_id: null, starts_at: at("2026-10-19", "07:00"), ends_at: at("2026-10-19", "11:00") });
    const all = [alice, bobMon, bobMon2, camTue, unassigned];
    const days = daysByBooking(all);
    const dayOf = (b: BoardBooking, key: string) => days.get(b.id)!.find((d) => d.dateKey === key)!;

    expect(otherStaffOnJobDay({ booking: alice, day: dayOf(alice, "2026-10-19") }, all, days)).toEqual(["bob"]);
    // Wednesday — the middle-and-last day of Alice's booking — nobody else.
    expect(otherStaffOnJobDay({ booking: alice, day: dayOf(alice, "2026-10-21") }, all, days)).toEqual([]);
    expect(otherStaffOnJobDay({ booking: alice, day: dayOf(alice, "2026-10-20") }, all, days)).toEqual(["cam"]);
    // The Unassigned tile names everyone booked that day.
    expect(otherStaffOnJobDay({ booking: unassigned, day: dayOf(unassigned, "2026-10-19") }, all, days)).toEqual(["alice", "bob"]);
  });

  it("shortens names", () => {
    expect(firstName("Dave Smith")).toBe("Dave");
    expect(firstName("Dave Smith (inactive)")).toBe("Dave");
    expect(nameInitials("Dave Smith")).toBe("DS");
    expect(nameInitials("Dave Smith (inactive)")).toBe("DS");
    expect(nameInitials("Cher")).toBe("C");
  });
});
