// The schedule board's "pick something, then click a technician's day" modes
// and its press-and-hold booking menu (Justin, 23 Nov 2026: "make the web
// schedule like the phone's — hit Schedule and type the job … press and hold
// on a job and copy it so we can paste it into another employee's schedule").
// Pure: the board (team-schedule-view.tsx) holds the state and does the writes.
// Web only — not mirrored to the phone (its schedule tab has its own sheets).
import { canFlagMissed, isMissed, type AttendanceBooking, type MissedFields } from "@/lib/booking-attendance";

// ---------------------------------------------------------------------------
// Press and hold vs drag
// ---------------------------------------------------------------------------

/** A still press this long opens the booking's menu. */
export const HOLD_MS = 500;

/**
 * Mouse and pen: a drag starts once the pointer has moved this far, at once —
 * no hold needed (a held, STILL button is the menu). The same distance cancels
 * a hold, so a press is exactly one of the two.
 */
export const DRAG_DISTANCE_PX = 6;

/**
 * Touch keeps the old press-and-hold drag (a swipe across a card must not move
 * a booking by accident): the drag starts after 200 ms if the finger stays
 * within 8 px. The menu still opens at HOLD_MS while the finger stays put; a
 * release there leaves the booking where it was and the menu open, and moving
 * on drags it (and closes the menu).
 */
export const TOUCH_DRAG = { delay: 200, tolerance: 8 } as const;

export type DragConstraint = { distance: number } | { delay: number; tolerance: number };

/** The dnd-kit activation constraint for a press, by its pointer type. */
export function boardDragConstraint(pointerType: string | null | undefined): DragConstraint {
  return pointerType === "touch" ? { ...TOUCH_DRAG } : { distance: DRAG_DISTANCE_PX };
}

/** How far a hold may wander and still be a hold. */
export function holdTolerance(pointerType: string | null | undefined): number {
  return pointerType === "touch" ? TOUCH_DRAG.tolerance : DRAG_DISTANCE_PX;
}

export type Point = { x: number; y: number };

/** Moved further than `px` from `from` — dnd-kit's own test (strictly more). */
export function movedBeyond(from: Point, to: Point, px: number): boolean {
  return Math.hypot(to.x - from.x, to.y - from.y) > px;
}

// ---------------------------------------------------------------------------
// The booking menu
// ---------------------------------------------------------------------------

export type BookingMenuAction = "copy" | "cut" | "schedule" | "open" | "todo" | "missed";

export type BookingMenuItem = { action: BookingMenuAction; label: string; disabled?: string };

/**
 * What the menu offers for a booking. A `closed` (completed/cancelled) job's
 * booking offers only "Open job" — the board shows completed jobs greyed
 * beside the open ones (24 Nov 2026), and copy / cut / back to the to-do list
 * would all be refused (0096). `unsaved` (a stand-in still waiting for its
 * row, or one derived from the job window on a database without bookings)
 * shows the rest greyed with the reason.
 */
export function bookingMenuItems(opts: {
  closed: string | null;
  unsaved: boolean;
  readOnly: boolean;
  canTodo: boolean;
  /** "Didn't make it" for the office (missedAction): offer to flag, to change/clear, or nothing. */
  missed?: MissedAction;
}): BookingMenuItem[] {
  if (opts.closed) return [{ action: "open", label: "Open job" }];
  const blocked = opts.readOnly
    ? "Bookings aren't set up in this database yet"
    : opts.closed
      ? `This job is ${opts.closed}`
      : opts.unsaved
        ? "Still saving"
        : undefined;
  const items: BookingMenuItem[] = [
    { action: "copy", label: "Copy to another technician or day", disabled: blocked },
    { action: "cut", label: "Cut (move)", disabled: blocked },
    { action: "schedule", label: "Edit this job's schedule…", disabled: opts.closed ? `This job is ${opts.closed}` : undefined },
    { action: "open", label: "Open job" },
  ];
  if (opts.canTodo) items.push({ action: "todo", label: "Back to to-do list", disabled: blocked });
  if (opts.missed) {
    items.push({
      action: "missed",
      label: opts.missed === "change" ? "Didn't make it — change or clear…" : "Didn't make it…",
      disabled: opts.unsaved ? "Still saving" : undefined,
    });
  }
  return items;
}

/** What "Didn't make it" offers on a booking: flag it, change/clear its flag, or nothing. */
export type MissedAction = "flag" | "change" | null;

/**
 * Office/admin only on the web (27 Nov 2026; the phone is the technician's
 * door). The same rules as 0121's functions (`canFlagMissed`: someone's
 * booking, open job, first booked day today or earlier) — the route and the
 * database decide again.
 */
export function missedAction(
  booking: Pick<AttendanceBooking, "staff_id" | "starts_at" | "ends_at" | "daily"> & MissedFields,
  jobStatus: string | null | undefined,
  todayKey: string,
  isOffice: boolean,
): MissedAction {
  if (!isOffice || !canFlagMissed(booking, jobStatus, todayKey)) return null;
  return isMissed(booking) ? "change" : "flag";
}

/**
 * Where the menu goes: just below-right of the press (so the finger or cursor
 * that opened it isn't on an item when it lets go), flipped and clamped to
 * stay inside the viewport with a margin.
 */
export function menuPlacement(at: Point, size: { width: number; height: number }, viewport: { width: number; height: number }, margin = 8): Point {
  const offset = 6;
  let x = at.x + offset;
  let y = at.y + offset;
  if (x + size.width + margin > viewport.width) x = at.x - offset - size.width;
  if (y + size.height + margin > viewport.height) y = at.y - offset - size.height;
  x = Math.min(Math.max(margin, x), Math.max(margin, viewport.width - size.width - margin));
  y = Math.min(Math.max(margin, y), Math.max(margin, viewport.height - size.height - margin));
  return { x, y };
}

// ---------------------------------------------------------------------------
// Pick modes: what the next click on a technician's day does
// ---------------------------------------------------------------------------

/** A booking picked up from a cell. */
export type Pickup = { bookingId: string; source: { staffId: string | null; dateKey: string } };

/** A job picked from the search, to be scheduled on the day clicked next. */
export type ScheduleJobPick = { id: string; job_number: number; title: string };

export type BoardMode<T = unknown> =
  | { kind: "none" }
  /** Double-click or "Cut": the next click MOVES it there, then the mode ends. */
  | { kind: "cut"; pickup: Pickup }
  /** "Copy": every click pastes a copy there; Esc / Done ends it. */
  | { kind: "copy"; pickup: Pickup; jobNumber: number }
  /** A to-do job picked to place (tap-to-place). */
  | { kind: "todo"; job: T }
  /** "Schedule": the next click opens the job's Schedule dialog on that technician and day. */
  | { kind: "schedule"; job: ScheduleJobPick };

export type BoardModeAction<T = unknown> =
  | { type: "cut"; pickup: Pickup }
  | { type: "copy"; pickup: Pickup; jobNumber: number }
  | { type: "todo"; job: T }
  | { type: "schedule"; job: ScheduleJobPick }
  /** A click on a day was handled: one-shot modes end, copy carries on. */
  | { type: "picked" }
  /** End the mode — any mode, or only `kind` when given (so clearing one never ends another). */
  | { type: "clear"; kind?: BoardMode["kind"] };

export const NO_MODE: BoardMode<never> = { kind: "none" };

/** One mode at a time: starting one replaces whatever was going on. */
export function boardModeReducer<T>(state: BoardMode<T>, action: BoardModeAction<T>): BoardMode<T> {
  switch (action.type) {
    case "cut":
      return { kind: "cut", pickup: action.pickup };
    case "copy":
      return { kind: "copy", pickup: action.pickup, jobNumber: action.jobNumber };
    case "todo":
      return { kind: "todo", job: action.job };
    case "schedule":
      return { kind: "schedule", job: action.job };
    case "picked":
      return state.kind === "copy" ? state : { kind: "none" };
    case "clear":
      if (state.kind === "none") return state;
      return !action.kind || action.kind === state.kind ? { kind: "none" } : state;
  }
}

/** Whether a click on a day should be taken by the board (and not open the job under it). */
export function modeTakesClicks(mode: BoardMode<unknown>): boolean {
  return mode.kind !== "none";
}

/** Why a copy can't be pasted on a cell, or null. Before any write. */
export function copyRefusal(target: { staffId: string | null }, plannedCopy: unknown | null, targetName: string): string | null {
  if (!target.staffId) return "A copy needs a technician — click a technician's day, not Unassigned.";
  if (!plannedCopy) return `${targetName} already has this booking then — nothing to copy.`;
  return null;
}
