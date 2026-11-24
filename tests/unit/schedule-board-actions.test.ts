import { describe, it, expect } from "vitest";
import {
  DRAG_DISTANCE_PX,
  HOLD_MS,
  NO_MODE,
  TOUCH_DRAG,
  boardDragConstraint,
  boardModeReducer,
  bookingMenuItems,
  copyRefusal,
  holdTolerance,
  menuPlacement,
  modeTakesClicks,
  movedBeyond,
  type BoardMode,
  type Pickup,
} from "@/components/schedule/board-actions";
import { planBoardAdd, type BoardBooking } from "@/components/schedule/board-model";
import { bookingsForScheduleDialog, costCentersFromPurchaseOrders } from "@/lib/schedule-dialog-data";
import { fromBusinessInputValue } from "@/lib/date";

const at = (key: string, time: string) => fromBusinessInputValue(`${key}T${time}`);

function booking(overrides: Partial<BoardBooking> = {}): BoardBooking {
  return {
    id: "b-1",
    job_id: "job-1",
    staff_id: "alice",
    cost_center_id: "cc-rough",
    starts_at: at("2026-11-24", "07:00"),
    ends_at: at("2026-11-24", "15:30"),
    daily: false,
    all_day: true,
    note: "Side gate",
    cost_center_name: "Rough-in",
    ...overrides,
  };
}

describe("hold vs drag", () => {
  it("a mouse or pen drag starts on movement alone; touch keeps the 200 ms hold", () => {
    expect(boardDragConstraint("mouse")).toEqual({ distance: DRAG_DISTANCE_PX });
    expect(boardDragConstraint("pen")).toEqual({ distance: DRAG_DISTANCE_PX });
    expect(boardDragConstraint(undefined)).toEqual({ distance: DRAG_DISTANCE_PX });
    expect(boardDragConstraint("touch")).toEqual({ delay: 200, tolerance: 8 });
  });

  it("the menu's hold is longer than the touch drag's, so a finger can hold, then drag", () => {
    expect(HOLD_MS).toBeGreaterThan(TOUCH_DRAG.delay);
  });

  it("a hold is cancelled by exactly the movement that starts a drag", () => {
    // The same distance and the same strict test dnd-kit uses: a press is one or the other.
    const tol = holdTolerance("mouse");
    expect(tol).toBe(DRAG_DISTANCE_PX);
    expect(movedBeyond({ x: 0, y: 0 }, { x: tol, y: 0 }, tol)).toBe(false);
    expect(movedBeyond({ x: 0, y: 0 }, { x: tol, y: 1 }, tol)).toBe(true);
    expect(holdTolerance("touch")).toBe(TOUCH_DRAG.tolerance);
  });

  it("measures straight-line distance", () => {
    expect(movedBeyond({ x: 10, y: 10 }, { x: 13, y: 14 }, 5)).toBe(false); // exactly 5
    expect(movedBeyond({ x: 10, y: 10 }, { x: 14, y: 14 }, 5)).toBe(true);
  });
});

describe("bookingMenuItems", () => {
  const actions = (items: ReturnType<typeof bookingMenuItems>) => items.map((i) => i.action);

  it("offers copy, cut, the job's schedule and open — plus back to the to-do list for the office", () => {
    expect(actions(bookingMenuItems({ closed: null, unsaved: false, readOnly: false, canTodo: true }))).toEqual([
      "copy",
      "cut",
      "schedule",
      "open",
      "todo",
    ]);
    expect(actions(bookingMenuItems({ closed: null, unsaved: false, readOnly: false, canTodo: false }))).not.toContain("todo");
    expect(bookingMenuItems({ closed: null, unsaved: false, readOnly: false, canTodo: true }).every((i) => !i.disabled)).toBe(true);
  });

  it("a closed job's booking offers only Open job — no copy, cut, schedule or to-do", () => {
    const items = bookingMenuItems({ closed: "completed", unsaved: false, readOnly: false, canTodo: true });
    expect(items).toEqual([{ action: "open", label: "Open job" }]);
  });

  it("a booking still saving can't be copied or moved yet, but its job's schedule opens", () => {
    const items = bookingMenuItems({ closed: null, unsaved: true, readOnly: false, canTodo: true });
    expect(items.filter((i) => !i.disabled).map((i) => i.action)).toEqual(["schedule", "open"]);
  });

  it("a board without bookings (no 0079) refuses copy and cut", () => {
    const items = bookingMenuItems({ closed: null, unsaved: false, readOnly: true, canTodo: false });
    expect(items.find((i) => i.action === "copy")?.disabled).toMatch(/isn't|aren't/);
  });
});

describe("menuPlacement", () => {
  const viewport = { width: 1000, height: 800 };
  const size = { width: 256, height: 200 };

  it("sits just below-right of the press, off the finger", () => {
    expect(menuPlacement({ x: 100, y: 100 }, size, viewport)).toEqual({ x: 106, y: 106 });
  });

  it("flips left and up near the right and bottom edges", () => {
    expect(menuPlacement({ x: 900, y: 700 }, size, viewport)).toEqual({ x: 900 - 6 - 256, y: 700 - 6 - 200 });
  });

  it("stays inside a phone-sized viewport", () => {
    const p = menuPlacement({ x: 200, y: 20 }, size, { width: 390, height: 844 });
    expect(p.x).toBeGreaterThanOrEqual(8);
    expect(p.x + size.width).toBeLessThanOrEqual(390 - 8);
  });
});

describe("boardModeReducer — what the next click on a day does", () => {
  const pickup: Pickup = { bookingId: "b-1", source: { staffId: "alice", dateKey: "2026-11-24" } };
  const job = { id: "job-1", job_number: 123, title: "Lot 4" };
  type Todo = { id: string };
  const reduce = (s: BoardMode<Todo>, ...actions: Parameters<typeof boardModeReducer<Todo>>[1][]) =>
    actions.reduce((acc, a) => boardModeReducer<Todo>(acc, a), s);

  it("starts with nothing picked, and no clicks are taken", () => {
    expect(NO_MODE.kind).toBe("none");
    expect(modeTakesClicks(NO_MODE)).toBe(false);
  });

  it("cut is one paste; copy keeps pasting until cleared", () => {
    expect(reduce(NO_MODE, { type: "cut", pickup }, { type: "picked" })).toEqual({ kind: "none" });
    const copying = reduce(NO_MODE, { type: "copy", pickup, jobNumber: 123 }, { type: "picked" }, { type: "picked" });
    expect(copying).toEqual({ kind: "copy", pickup, jobNumber: 123 });
    expect(modeTakesClicks(copying)).toBe(true);
    expect(reduce(copying, { type: "clear" })).toEqual({ kind: "none" });
  });

  it("schedule mode ends once a day is picked (the dialog takes over)", () => {
    const s = reduce(NO_MODE, { type: "schedule", job });
    expect(s).toEqual({ kind: "schedule", job });
    expect(reduce(s, { type: "picked" })).toEqual({ kind: "none" });
  });

  it("one mode at a time: starting one replaces another", () => {
    const s = reduce(NO_MODE, { type: "copy", pickup, jobNumber: 123 }, { type: "todo", job: { id: "t" } });
    expect(s).toEqual({ kind: "todo", job: { id: "t" } });
    expect(reduce(s, { type: "schedule", job }).kind).toBe("schedule");
  });

  it("clearing one kind never ends another", () => {
    const copying = reduce(NO_MODE, { type: "copy", pickup, jobNumber: 123 });
    expect(reduce(copying, { type: "clear", kind: "cut" })).toBe(copying);
    expect(reduce(copying, { type: "clear", kind: "copy" })).toEqual({ kind: "none" });
  });
});

describe("Copy mode pastes — the Shift-drop rules", () => {
  const source = { staffId: "alice", dateKey: "2026-11-24" };

  it("pasting twice books two more technicians, each a full copy", () => {
    const b = booking();
    const toSam = planBoardAdd(b, source, { staffId: "sam", dateKey: "2026-11-24" }, [b]);
    expect(toSam).toMatchObject({ staff_id: "sam", cost_center_id: "cc-rough", starts_at: b.starts_at, ends_at: b.ends_at, note: "Side gate" });
    const samRow = { ...b, ...toSam!, id: "b-sam" };
    const toDan = planBoardAdd(b, source, { staffId: "dan", dateKey: "2026-11-25" }, [b, samRow]);
    expect(toDan).toMatchObject({ staff_id: "dan", starts_at: at("2026-11-25", "07:00"), ends_at: at("2026-11-25", "15:30") });
    expect(copyRefusal({ staffId: "dan" }, toDan, "Dan")).toBeNull();
  });

  it("a second paste on the same technician and day is refused, with the reason", () => {
    const b = booking();
    const first = planBoardAdd(b, source, { staffId: "sam", dateKey: "2026-11-24" }, [b]);
    const again = planBoardAdd(b, source, { staffId: "sam", dateKey: "2026-11-24" }, [b, { ...b, ...first!, id: "b-sam" }]);
    expect(again).toBeNull();
    expect(copyRefusal({ staffId: "sam" }, again, "Sam")).toBe("Sam already has this booking then — nothing to copy.");
  });

  it("Unassigned is refused (a copy needs a technician)", () => {
    const b = booking();
    const copy = planBoardAdd(b, source, { staffId: null, dateKey: "2026-11-24" }, [b]);
    expect(copyRefusal({ staffId: null }, copy, "Unassigned")).toMatch(/needs a technician/);
  });
});

describe("schedule dialog data (shared by the job page and the board)", () => {
  it("flattens a job's PO lines, names only", () => {
    const lines = costCentersFromPurchaseOrders([
      { po_number: "834-1", po_cost_centers: [{ id: "l1", name: "Drainage", code: "D", cost_centre_id: "c1" }] },
      { po_number: "B-77", po_cost_centers: [{ id: "l2", name: "Transport" }] },
      { po_number: "B-78", po_cost_centers: null },
    ]);
    expect(lines).toEqual([
      { id: "l1", name: "Drainage", code: "D", po_number: "834-1", cost_centre_id: "c1" },
      { id: "l2", name: "Transport", code: null, po_number: "B-77", cost_centre_id: null },
    ]);
    expect(Object.keys(lines[0])).not.toContain("allocated_amount");
  });

  it("uses the saved bookings when the table exists", () => {
    const loaded = [{ ...booking(), staff_name: "Alice", cost_center_name: "Rough-in" }];
    expect(
      bookingsForScheduleDialog({
        bookingsReady: true,
        loaded,
        job: { id: "job-1", scheduled_start: null, scheduled_end: null },
        crew: [],
        staff: [],
        purchaseOrders: [],
      }),
    ).toBe(loaded);
  });

  it("without the bookings table, derives one per crew member from the job's window, named", () => {
    const rows = bookingsForScheduleDialog({
      bookingsReady: false,
      loaded: [],
      job: { id: "job-1", scheduled_start: at("2026-11-24", "07:00"), scheduled_end: at("2026-11-24", "15:30"), scheduled_cost_center_id: "l1" },
      crew: ["alice", "sam"],
      staff: [
        { id: "alice", full_name: "Alice" },
        { id: "sam", full_name: "Sam" },
      ],
      purchaseOrders: [{ po_number: "1", po_cost_centers: [{ id: "l1", name: "Drainage" }] }],
    });
    expect(rows.map((r) => [r.staff_name, r.cost_center_name])).toEqual([
      ["Alice", "Drainage"],
      ["Sam", "Drainage"],
    ]);
  });
});
