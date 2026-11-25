"use client";

import Link from "next/link";
import { Fragment, useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import {
  DndContext,
  DragOverlay,
  closestCenter,
  pointerWithin,
  type CollisionDetection,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragMoveEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { toast } from "sonner";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
// Every move writes ONE booking row (lib/bookings.ts) and then pushes the job
// to Google Calendar (pushJobToCalendar — a move the calendar never hears
// about is what the poll in lib/google.ts used to "correct" by undoing it).
// The crew and the job's own window follow from the bookings in the database
// (triggers in 0079 yet), so nothing here writes
// assigned_to, job_assignments or jobs.scheduled_* any more.
import { pushJobToCalendar } from "@/lib/schedule-dispatch";
import { bookingWindow, deleteBooking, insertBookings, updateBooking, type BookingWriteClient } from "@/lib/bookings";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { TodoListPanel, type TodoJob } from "./todo-list-panel";
import { TodoBoardPanel, TodoDragCard } from "./todo-board-panel";
// The to-do list beside the board (drag in, drag out, unbooked hours) — rules
// in lib/todo-board.ts, web only.
import {
  describeDragOut,
  jobPatchAfterDrop,
  newBookingClashes,
  planDragOut,
  planTodoDrop,
  TODO_PANEL_DROP_ID,
  unbookedHours,
  type DayGap,
} from "@/lib/todo-board";
import { todoHours } from "@/lib/todo-list";
import { BoardJobLink } from "./board-job-link";
import { BookingCostCentreDialog, type CostCentreRequest, type PickedCostCentre } from "./booking-cost-centre-dialog";
import { ScheduleExistingJobDialog } from "./schedule-existing-job-dialog";
import type { SchedulePrefill } from "@/lib/schedule-existing-job";
// Press and hold (or right-click) a booking for its menu — Copy, Cut, Open —
// and the "pick, then click a technician's day" modes (23 Nov 2026).
import {
  NO_MODE,
  boardModeReducer,
  bookingMenuItems,
  copyRefusal,
  movedBeyond,
  holdTolerance,
  type BoardMode,
  type BookingMenuAction,
  type Pickup,
  type Point,
  type ScheduleJobPick,
} from "./board-actions";
import { BoardPointerSensor, BookingMenu, useHoldGesture } from "./booking-hold-menu";
import { BoardScheduleDialog } from "./board-schedule-dialog";
import {
  applyBoardMove,
  buildBoardIndex,
  columnId,
  dayOfLabel,
  daysByBooking,
  firstName,
  formatHours,
  isClosedJob,
  jobDaysFromBookings,
  nameInitials,
  otherStaffOnJobDay,
  parseBoardTarget,
  planBoardMove,
  planBoardAdd,
  planBookingResize,
  buildResizePreviewIndex,
  resizeBlockedReason,
  resizeConflicts,
  totalHours,
  weekCellId,
  type BoardBooking,
  type BoardCell,
  type BoardEntry,
  type BoardIndex,
  type BoardJob,
  type BookingPatch,
  type ResizeConflict,
  type ResizeEdge,
  type ResizePlan,
} from "./board-model";
import { scheduleDays } from "@/lib/scheduling";
import { formatDateKeyRange } from "@/lib/schedule-form";
// Staff leave (0112 — a draft, not applied yet): read-only tiles, "Needs reassigning" flags and the
// confirm before booking someone onto a leave day. The rules are shared with
// the phone (lib/staff-leave.ts ↔ mobile/lib/staffLeave.ts).
import {
  NEEDS_REASSIGNING,
  bookingDaysForLeave,
  bookingLeaveConflicts,
  bookingsNeedingReassignment,
  buildLeaveIndex,
  describeLeaveConflicts,
  leaveColour,
  leaveDayLabel,
  leaveLabel,
  leaveRangeLabel,
  type LeaveConflict,
  type LeaveDay,
  type ScheduleLeave,
} from "@/lib/staff-leave";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Navigation, LayoutList, ListTodo, ChevronLeft, ChevronRight, CalendarDays, CalendarRange, Scissors, StickyNote, X, CalendarPlus, Plus, Copy } from "lucide-react";
import {
  formatTime,
  formatDate,
  dateKeyInBusinessTZ,
  shiftDateKey,
  anchorForDateKey,
  weekDateKeys,
} from "@/lib/date";
import { jobStatusColors } from "@/lib/badge-colors";
import { scheduleBlockTones } from "@/lib/schedule-block-tones";
import { bookingOverHours, formatOverHours, jobsOverHours, type HoursByJob, type OverHours } from "@/lib/over-hours";
import { OverHoursSummary, type OverHoursJob } from "./over-hours-summary";
// The phone's layout (25 Nov 2026): Day is a time-of-day timeline per
// technician, blocks sized by their hours with lanes for overlaps — the same
// rules as the phone's grid (lib/schedule-grid.ts ↔ mobile/lib/scheduleGrid.ts).
import { dayTimelineHours, layoutDayRow, minutesIntoDay } from "@/lib/schedule-grid";
// Rest the mouse on a booking: the job's details without opening it.
import { BookingHoverCard, hoverHandlers, useHoverCard, useHoverCardId } from "./booking-hover-card";
import { hoverCardDetails, statusLabel } from "@/lib/schedule-hover";
import { cn } from "@/lib/utils";

type StaffMember = {
  id: string;
  full_name: string;
  role: string;
};


/**
 * An edge resize in progress. `booking` is the row as it was when the drag
 * began — what a cancel or a failed save snaps back to; the board draws the
 * preview from it plus `delta` whole days.
 *   dragging — following the pointer
 *   confirm  — released onto days that clash; waiting for "Book anyway"
 *   saving   — written, waiting for the server
 */
type ResizeState = {
  booking: BoardBooking;
  job: BoardJob;
  edge: ResizeEdge;
  delta: number;
  phase: "dragging" | "confirm" | "saving";
  conflicts: ResizeConflict[];
  /** Days the stretched booking gains that its technician is on leave. */
  leaveConflicts: LeaveConflict[];
};

/** The pointer side of a resize: where it started and how wide a day column is. */
type ResizeGesture = {
  pointerId: number;
  startX: number;
  lastX: number;
  dayWidth: number;
  /** The week grid's horizontal scroller — auto-scrolled near its edges, and its scroll counts toward the drag. */
  scroller: HTMLElement | null;
  startScroll: number;
};

// Within this many px of the scroller's edge a resize scrolls the week grid
// (a phone shows two or three day columns at a time).
const AUTO_SCROLL_EDGE_PX = 40;
const AUTO_SCROLL_STEP_PX = 12;

/** Whole days the pointer has travelled, counting any auto-scroll of the grid. */
function gestureDelta(g: ResizeGesture): number {
  const scrolled = (g.scroller?.scrollLeft ?? 0) - g.startScroll;
  return Math.round((g.lastX - g.startX + scrolled) / g.dayWidth);
}

/** Each technician's booked hours over the days an index covers. */
function hoursByStaff(index: BoardIndex): Map<string, number> {
  const totals = new Map<string, number>();
  for (const [staffId, byDay] of index.hours) totals.set(staffId, totalHours(byDay));
  return totals;
}

function wazeUrl(site: BoardJob["sites"]): string | null {
  if (!site) return null;
  if (site.site_lat && site.site_lng) {
    return `https://waze.com/ul?ll=${site.site_lat},${site.site_lng}&navigate=yes`;
  }
  if (site.address_line1) {
    const query = encodeURIComponent(`${site.address_line1} ${site.suburb ?? ""} ${site.state ?? ""}`);
    return `https://waze.com/ul?q=${query}&navigate=yes`;
  }
  return null;
}

function WazeButton({ site }: { site: BoardJob["sites"] }) {
  const url = wazeUrl(site);
  if (!url) return null;
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      className="inline-flex items-center gap-1 text-xs text-blue-600 hover:underline flex-shrink-0"
      title="Navigate with Waze"
    >
      <Navigation className="w-3.5 h-3.5" />
      Waze
    </a>
  );
}

// AU/ISO convention: weeks in the week view run Monday-Sunday, matching
// weekDateKeys()/startOfWeekKey() in lib/date.ts.
function formatWeekRangeLabel(weekKeys: string[]) {
  const start = anchorForDateKey(weekKeys[0]);
  const end = anchorForDateKey(weekKeys[weekKeys.length - 1]);
  const sameMonth = start.getUTCMonth() === end.getUTCMonth() && start.getUTCFullYear() === end.getUTCFullYear();
  const startLabel = formatDate(start, sameMonth ? { day: "numeric" } : { day: "numeric", month: "short" });
  const endLabel = formatDate(end, { day: "numeric", month: "short", year: "numeric" });
  return `${startLabel} – ${endLabel}`;
}

/**
 * Who a tile belongs to: its row's technician's full name (null in the
 * Unassigned row) and the full names of anyone else booked on the same job
 * that day. Built from the staff list and bookings the board already holds.
 */
type TileTag = { own: string | null; others: string[] };

/**
 * The name in a tile's top corner (Justin: on a wide week you lose sight of
 * which row is whose once it scrolls). First name, or initials when the tile
 * is narrow — a container query on the tile, so it follows the tile's real
 * width rather than the screen's. "+N" for the other technicians on the job
 * that day. Full names on hover (title) and on tap, which expands the tag in
 * place; the tap is kept from opening the job or cutting it.
 */
function TileStaffTag({ tag }: { tag: TileTag }) {
  const [expanded, setExpanded] = useState(false);
  const ownFull = tag.own ?? "Unassigned";
  const full = tag.others.length > 0 ? `${ownFull}, with ${tag.others.join(", ")}` : ownFull;
  const stop = (e: React.SyntheticEvent) => {
    e.preventDefault();
    e.stopPropagation();
  };
  return (
    <span
      role="button"
      tabIndex={0}
      title={full}
      aria-label={`Booked: ${full}`}
      aria-expanded={expanded}
      onClick={(e) => {
        stop(e);
        setExpanded((v) => !v);
      }}
      onDoubleClick={stop}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          stop(e);
          setExpanded((v) => !v);
        }
      }}
      className={cn(
        "inline-flex items-center gap-0.5 rounded px-1 text-[10px] font-semibold leading-4 flex-shrink-0 cursor-help",
        tag.own ? "bg-slate-100 text-slate-700" : "bg-amber-100 text-amber-800",
        expanded ? "whitespace-normal break-words" : "max-w-full whitespace-nowrap"
      )}
    >
      {expanded ? (
        full
      ) : (
        <>
          {tag.own ? (
            <>
              <span className="hidden @[110px]:inline truncate">{firstName(tag.own)}</span>
              <span className="@[110px]:hidden">{nameInitials(tag.own)}</span>
            </>
          ) : (
            <span>No tech</span>
          )}
          {tag.others.length > 0 && <span className="text-slate-500 font-medium">+{tag.others.length}</span>}
        </>
      )}
    </span>
  );
}

/**
 * A day of staff leave in a technician's cell: striped, in the leave type's
 * colour, labelled "Sick" / "Annual leave" / … (or "Unavailable" when the
 * database withheld the type from this viewer). Read-only — not draggable,
 * no resize handles, never a drop of its own; a click opens the leave
 * details and never reaches the cell (so it can't paste a cut booking).
 */
function LeaveTile({
  day,
  compact,
  position,
  onOpen,
}: {
  day: LeaveDay;
  compact?: boolean;
  /** Day timeline: where it sits in the row (lib/schedule-grid.ts layoutDayRow). */
  position?: { left: number; top: number; width: number };
  onOpen: (day: LeaveDay) => void;
}) {
  const c = leaveColour(day.leave.leave_type);
  return (
    <button
      type="button"
      data-leave-tile
      title={`${leaveDayLabel(day)} — ${leaveRangeLabel(day.leave)} (read only)`}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onOpen(day);
      }}
      onDoubleClick={stopEvent}
      className={cn(
        "block text-left rounded-lg border border-l-4 font-semibold cursor-pointer overflow-hidden",
        position ? "absolute z-[1]" : "w-full",
        compact ? "px-1.5 py-[3px]" : "px-3 py-2"
      )}
      style={{
        ...(position ? { left: position.left, top: position.top, width: position.width } : null),
        height: BLOCK_HEIGHT,
        background: `repeating-linear-gradient(135deg, ${c.bg} 0 7px, #ffffff 7px 10px)`,
        borderColor: c.border,
        color: c.text,
      }}
    >
      <span className={cn("block truncate", compact ? "text-[11px]" : "text-sm")}>{leaveDayLabel(day)}</span>
      <span className={cn("block truncate font-medium opacity-80", compact ? "text-[10px]" : "text-xs")}>
        {day.fullDay ? "Not available" : "Part day"}
      </span>
    </button>
  );
}

/** Hover-card wiring for one placed booking (mouse rest / keyboard focus → the job's details). */
type HoverWiring = ReturnType<typeof hoverHandlers<BoardEntry>>;

/** Props every placed card shares: where it sits, who it belongs to, and the cut/copy wiring. */
type PlacedProps = {
  entry: BoardEntry;
  source: BoardCell;
  tag: TileTag;
  /** The booking cut (amber) or being copied (blue) — highlighted where it was picked up. */
  cut: Pickup | null;
  copying: boolean;
  /** A mode is waiting for a day to be clicked: a click on a card goes to its cell, never opens the job. */
  pickActive: boolean;
  onCut: (pickup: Pickup) => void;
  /** Press and hold / right-click (office/admin): the booking's menu at the press. */
  onMenu?: (pickup: Pickup, at: Point) => void;
  /** The hover card's pointer/focus handlers for this booking. */
  hoverFor?: (entry: BoardEntry) => HoverWiring;
  /** Booked on a day this technician is on leave (0112). */
  reassign: boolean;
  /** The job is completed (or cancelled): greyed, never dragged, cut or resized. */
  closed?: boolean;
  /** Over its allowed hours (office/admin only; lib/over-hours.ts). */
  over?: OverHours | null;
};

/** Said when someone tries to move (cut, drag) a completed job's booking. */
function closedMoveMessage(job: Pick<BoardJob, "job_number" | "status">): string {
  return `#${job.job_number} is ${job.status} — its bookings can't be moved.`;
}

function isCutHere(cut: Pickup | null, bookingId: string, source: BoardCell) {
  return !!cut && cut.bookingId === bookingId && cut.source.staffId === source.staffId && cut.source.dateKey === source.dateKey;
}

// ---------------------------------------------------------------------------
// A booking block — drawn like the phone's (mobile/components/schedule/
// ScheduleGrid.tsx Block, 25 Nov 2026): tinted in its job status's colour
// with a thick left edge, "#123" and the technician tag on top, then the
// flags (Completed / Needs reassigning / ⚠ Over), the start time in Week view
// and the title. The web adds a third line for the cost centre and the
// booking's note (the phone shows those in its booking sheet; here the
// hover card has the rest).
// ---------------------------------------------------------------------------

/** One lane of the board, in CSS px — the phone's 52 pt lane plus room for the third line. */
const WEB_LANE_HEIGHT = 62;
const BLOCK_HEIGHT = WEB_LANE_HEIGHT - 6;
/** The Day timeline's width per hour (the phone's HOUR_WIDTH is 72 pt). */
const WEB_HOUR_WIDTH = 84;
const NAME_COLUMN_WIDTH = 168;

/** The phone's block colours: status tint, completed slate + dashed, over amber, on leave rose. */
function blockStyle(job: BoardJob, over: OverHours | null | undefined, reassign: boolean): React.CSSProperties {
  const completed = isClosedJob(job);
  const tone = completed ? null : scheduleBlockTones[job.status] ?? null;
  const style: React.CSSProperties = {
    backgroundColor: tone?.bg ?? scheduleBlockTones.scheduled.bg,
    borderColor: tone?.text ?? scheduleBlockTones.scheduled.text,
    borderStyle: "solid",
    borderWidth: 1,
    borderLeftWidth: 4,
  };
  if (completed) Object.assign(style, { backgroundColor: "#f1f5f9", borderColor: "#94a3b8", borderStyle: "dashed", opacity: 0.85 });
  if (over && !reassign) Object.assign(style, { borderColor: "#d97706", borderWidth: 2, borderLeftWidth: 4 });
  if (reassign) Object.assign(style, { borderColor: "#e11d48", borderWidth: 2, borderLeftWidth: 4 });
  return style;
}

type BlockBodyProps = { entry: BoardEntry; tag: TileTag; reassign?: boolean; over?: OverHours | null; view: "day" | "week" };

function BlockBody({ entry, tag, reassign, over, view }: BlockBodyProps) {
  const { job, booking } = entry;
  const completed = isClosedJob(job);
  return (
    <>
      <div className="flex items-center justify-between gap-1">
        <p className={cn("min-w-0 truncate text-xs font-extrabold leading-4", completed ? "text-slate-500" : "text-slate-900")}>
          {completed ? "✓ " : ""}#{job.job_number}
        </p>
        <TileStaffTag tag={tag} />
      </div>
      <p className={cn("truncate text-[11px] leading-4", completed ? "text-slate-500" : "text-slate-700")}>
        {completed ? (job.status === "completed" ? "Completed · " : `${statusLabel(job.status)} · `) : ""}
        {reassign && <span className="font-extrabold text-rose-700" title="This technician is on leave this day">{NEEDS_REASSIGNING} · </span>}
        {over && (
          <span className="font-extrabold text-amber-700" title={over.text} data-over-hours={over.level}>
            ⚠ Over {formatOverHours(over.usedHours)}/{formatOverHours(over.allowedHours)} ·{" "}
          </span>
        )}
        {view === "week" ? <span className="font-semibold">{formatTime(entry.day.startIso)} </span> : null}
        {job.title}
      </p>
      {(booking.cost_center_name || booking.note) && (
        <p className="flex min-w-0 items-center gap-1 truncate text-[10px] leading-4">
          {booking.cost_center_name && <span className="truncate font-medium text-cyan-700">{booking.cost_center_name}</span>}
          {booking.note && (
            <span className="flex min-w-0 items-center gap-0.5 text-amber-700" title={booking.note}>
              <StickyNote className="h-2.5 w-2.5 flex-shrink-0" aria-hidden />
              <span className="truncate">{booking.note}</span>
            </span>
          )}
        </p>
      )}
    </>
  );
}

/**
 * The card's own pointer wiring beside dnd-kit's: a still press of HOLD_MS (or
 * a right-click) opens the booking's menu; moving first is a drag (dnd-kit);
 * a click opens the job; a double-click cuts it.
 */
function useCardGestures(
  listeners: ReturnType<typeof useDraggable>["listeners"],
  pickup: Pickup,
  onMenu: PlacedProps["onMenu"],
) {
  const menu = onMenu ? (at: Point) => onMenu(pickup, at) : undefined;
  const hold = useHoldGesture(menu);
  return {
    ...listeners,
    onPointerDown: (e: React.PointerEvent<HTMLElement>) => {
      listeners?.onPointerDown?.(e);
      hold(e);
    },
    onContextMenu: (e: React.MouseEvent) => {
      e.preventDefault();
      menu?.({ x: e.clientX, y: e.clientY });
    },
  };
}

const stopEvent = (e: React.SyntheticEvent) => {
  e.preventDefault();
  e.stopPropagation();
};

/**
 * A grab strip on a chip's left or right edge. Pointer events (mouse, pen and
 * touch alike); the board does the rest from window listeners, so the drag
 * survives this chip disappearing from under the pointer as the preview
 * redraws (shortening a booking removes its last day's chip).
 *
 * Keeping it apart from the chip's other gestures:
 *   - it is a SIBLING of the job link, not inside it, so no click on it can
 *     reach the link (open the job) or its double-click (cut);
 *   - pointerdown stops propagating, so the dnd-kit PointerSensor on the
 *     wrapper never sees the press and no move starts;
 *   - nothing here is HTML5-draggable (the board's moves are dnd-kit pointer
 *     drags, not native drag-and-drop);
 *   - touch-action: none, so a finger on it resizes instead of scrolling.
 * Always faintly visible on touch screens, which have no hover.
 */
function ResizeHandle({
  edge,
  onStart,
}: {
  edge: ResizeEdge;
  onStart: (edge: ResizeEdge, e: React.PointerEvent<HTMLElement>) => void;
}) {
  return (
    <div
      aria-hidden
      title={edge === "start" ? "Drag to change the first day" : "Drag to change the last day"}
      data-resize-handle={edge}
      onPointerDown={(e) => {
        if (e.pointerType === "mouse" && e.button !== 0) return;
        stopEvent(e);
        onStart(edge, e);
      }}
      onClick={stopEvent}
      onDoubleClick={stopEvent}
      onContextMenu={stopEvent}
      style={{ touchAction: "none" }}
      className={cn(
        "absolute inset-y-0 z-10 flex w-2.5 cursor-ew-resize items-center justify-center pointer-coarse:w-3.5",
        edge === "start" ? "left-0 rounded-l-lg" : "right-0 rounded-r-lg"
      )}
    >
      <span className="h-5 w-[3px] rounded-full bg-blue-400 opacity-0 transition-opacity group-hover/chip:opacity-100 pointer-coarse:bg-slate-400 pointer-coarse:opacity-80" />
    </div>
  );
}

// Resize handles sit on the booking's OUTER edges only (Week view): the left
// one on its first day's block, the right one on its last day's (a
// single-day booking has both). A day in the middle of a multi-day booking
// has none — its edges are not the booking's edges.
type ChipHandles = { start: boolean; end: boolean };
/** This chip's booking is being resized: a previewed day, a day the preview drops, or its save in flight. */
type ChipResizeState = "preview" | "removing" | "saving" | null;

/**
 * One placed booking, Day or Week view. Moving a pressed mouse (or a finger
 * held 200 ms, then moved) drags it; a still hold of HOLD_MS or a right-click
 * opens its menu (office/admin); a quick click opens the job; a double-click
 * cuts it for pasting (BoardJobLink); resting the mouse on it shows the hover
 * card.
 *
 * In Day view it is positioned on the timeline (`position`, from
 * lib/schedule-grid.ts layoutDayRow); in Week view it stacks in its cell.
 *
 * The draggable id is per PLACEMENT, not per booking: a multi-day booking
 * sits in several day cells at once and dnd-kit needs each node's id to be
 * unique. (A per-booking tag — e.g. "Added by technician" — belongs in
 * BlockBody, which both views and the drag overlay draw.)
 */
function DraggableBlock({
  entry,
  source,
  tag,
  cut,
  copying,
  pickActive,
  onCut,
  onMenu,
  hoverFor,
  reassign,
  closed,
  over,
  view,
  position,
  handles = null,
  onResizeStart,
  resizeState = null,
}: PlacedProps & {
  view: "day" | "week";
  /** Day view: where the block sits in its row (px). */
  position?: { left: number; top: number; width: number };
  handles?: ChipHandles | null;
  onResizeStart?: (entry: BoardEntry, edge: ResizeEdge, e: React.PointerEvent<HTMLElement>) => void;
  resizeState?: ChipResizeState;
}) {
  const { job, booking } = entry;
  const { setNodeRef, listeners, isDragging } = useDraggable({
    id: `${booking.id}@${weekCellId(source.staffId, source.dateKey)}`,
    data: { bookingId: booking.id, source, entry },
    // A completed job's bookings stay where they are (0096 refuses the write anyway).
    disabled: !!closed,
  });
  const isCut = isCutHere(cut, booking.id, source);
  const gestures = useCardGestures(listeners, { bookingId: booking.id, source }, onMenu);
  const hover = hoverFor?.(entry);
  const start = (edge: ResizeEdge, e: React.PointerEvent<HTMLElement>) => onResizeStart?.(entry, edge, e);
  return (
    <div
      ref={setNodeRef}
      {...gestures}
      {...hover}
      data-booking-card={booking.id}
      style={{
        touchAction: "none",
        WebkitTouchCallout: "none",
        WebkitUserSelect: "none",
        ...(position ? { position: "absolute", left: position.left, top: position.top, width: position.width } : null),
        height: BLOCK_HEIGHT,
      }}
      data-closed={closed ? "true" : undefined}
      className={cn(
        "group/chip select-none rounded-lg",
        position ? "z-[1]" : "relative",
        closed ? "cursor-pointer" : "cursor-grab active:cursor-grabbing",
        isDragging && "opacity-30",
        isCut && (copying ? "ring-2 ring-blue-500" : "ring-2 ring-amber-400"),
        resizeState === "preview" && "ring-2 ring-blue-400",
        resizeState === "removing" && "opacity-40 outline-2 outline-dashed outline-slate-400 line-through",
        resizeState === "saving" && "ring-2 ring-blue-300 animate-pulse"
      )}
    >
      <BoardJobLink
        href={`/dashboard/jobs/${job.id}`}
        className="block h-full rounded-lg focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-blue-600"
        cutActive={pickActive}
        onCut={() => (closed ? toast.error(closedMoveMessage(job)) : onCut({ bookingId: booking.id, source }))}
      >
        <div
          className={cn("@container h-full overflow-hidden rounded-lg py-[3px] hover:brightness-[0.97]", handles ? "px-2.5" : "px-1.5")}
          style={blockStyle(job, over, reassign)}
        >
          <BlockBody entry={entry} tag={tag} reassign={reassign} over={over} view={view} />
        </div>
      </BoardJobLink>
      {/* Two fixed slots, so a handle that stays keeps its DOM node (and its pointer capture). */}
      {handles?.start ? <ResizeHandle edge="start" onStart={start} /> : null}
      {handles?.end ? <ResizeHandle edge="end" onStart={start} /> : null}
    </div>
  );
}

/**
 * A technician's row on the Day timeline (or Unassigned) — the drop / paste
 * target for "give this booking to them" (a Day move changes the technician,
 * never the time, as on the phone). Hour lines are drawn as a background.
 */
function DroppableTimelineRow({
  id,
  width,
  height,
  onPick,
  children,
}: {
  id: string;
  width: number;
  height: number;
  /** Set while a pick mode is on: a click anywhere in the row places it here. */
  onPick?: (id: string) => void;
  children: React.ReactNode;
}) {
  const { setNodeRef, isOver } = useDroppable({ id });
  return (
    <div
      ref={setNodeRef}
      data-cell-id={id}
      data-timeline-row
      onClick={onPick ? () => onPick(id) : undefined}
      className={cn(
        "relative flex-shrink-0 border-b border-slate-200 bg-white",
        isOver && "bg-blue-50 ring-2 ring-inset ring-blue-400",
        onPick && "cursor-copy hover:bg-amber-50/60 hover:ring-2 hover:ring-inset hover:ring-amber-400"
      )}
      style={{
        width,
        height,
        backgroundImage: `repeating-linear-gradient(to right, transparent 0 ${WEB_HOUR_WIDTH - 1}px, #f1f5f9 ${WEB_HOUR_WIDTH - 1}px ${WEB_HOUR_WIDTH}px)`,
      }}
    >
      {children}
    </div>
  );
}

/** The red "now" line on today's Day timeline. Redrawn with the board; a minute of drift is fine. */
function NowLine({ dayKey, startHour, width }: { dayKey: string; startHour: number; width: number }) {
  const x = (minutesIntoDay(new Date().toISOString(), dayKey) / 60 - startHour) * WEB_HOUR_WIDTH;
  if (x <= 0 || x >= width) return null;
  return <div aria-hidden className="pointer-events-none absolute inset-y-0 z-[2] w-0.5 bg-red-600/60" style={{ left: x }} />;
}

// A single (staff-or-unassigned) x (day) cell in the week grid — droppable
// (and, while a job is cut, clickable) so a job can be moved onto a different
// technician's row and/or a different day column at once.
function DroppableWeekCell({
  id,
  isToday,
  hours,
  gap,
  onGapClick,
  onPick,
  onAddJob,
  children,
}: {
  id: string;
  isToday?: boolean;
  /** Booked hours for this technician on this day; omitted for Unassigned. */
  hours?: number;
  /** Unbooked hours (office/admin only — the to-do list's gap). */
  gap?: DayGap;
  onGapClick?: (hours: number) => void;
  onPick?: (id: string) => void;
  /** "Schedule an existing job" on this technician's day (office/admin, today on). */
  onAddJob?: () => void;
  children: React.ReactNode;
}) {
  const { setNodeRef, isOver } = useDroppable({ id });
  return (
    <div
      ref={setNodeRef}
      data-week-cell
      data-cell-id={id}
      onClick={onPick ? () => onPick(id) : undefined}
      className={cn(
        // As the phone's Week cell: leave first, then the bookings, one lane
        // each from the top; the "N h free" strip underneath.
        "group/cell flex flex-col gap-1.5 bg-white px-1 py-1.5 min-h-[76px] transition-colors",
        isToday && "bg-blue-50/40",
        isOver && "ring-2 ring-inset ring-blue-400 bg-blue-50/70",
        onPick && "cursor-copy hover:ring-2 hover:ring-inset hover:ring-amber-400"
      )}
    >
      {children}
      {((hours !== undefined && hours > 0) || (gap?.kind === "free" && gap.hours > 0) || (onAddJob && !onPick)) && (
        <div className="mt-auto flex items-center justify-between gap-1 leading-none">
          {gap?.kind === "free" && gap.hours > 0 ? <GapButton hours={gap.hours} onClick={onGapClick} compact /> : <span />}
          <span className="flex items-center gap-1">
            {hours !== undefined && hours > 0 && <span className="text-[10px] font-semibold text-slate-500">{formatHours(hours)}</span>}
            {onAddJob && !onPick && <AddExistingJobButton onClick={onAddJob} compact />}
          </span>
        </div>
      )}
    </div>
  );
}

/**
 * "+" on a technician's day: schedule an EXISTING job there (Justin's
 * notebook list, 20 Nov 2026). Opens the job search; the picked job's
 * Schedule dialog then opens with this technician and day filled in. Never
 * reaches the cell (no paste, no drop).
 */
function AddExistingJobButton({ onClick, compact }: { onClick: () => void; compact?: boolean }) {
  return (
    <button
      type="button"
      title="Schedule an existing job here"
      aria-label="Schedule an existing job here"
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onClick();
      }}
      className={cn(
        "inline-flex items-center gap-0.5 rounded border border-blue-200 bg-blue-50 font-semibold text-blue-700 hover:bg-blue-100",
        compact ? "px-1 text-[10px] leading-4 opacity-0 group-hover/cell:opacity-100 focus:opacity-100" : "px-1.5 py-0.5 text-xs"
      )}
    >
      <Plus className={compact ? "w-2.5 h-2.5" : "w-3 h-3"} />
      {compact ? null : "Add job"}
    </button>
  );
}

/**
 * A technician's unbooked hours on a day ("3 h free"). A click sets the to-do
 * panel's "Fits in" to it, so the office sees what can fill the gap. Never
 * reaches the cell (no paste, no drop).
 */
function GapButton({ hours, onClick, compact }: { hours: number; onClick?: (hours: number) => void; compact?: boolean }) {
  return (
    <button
      type="button"
      data-gap-hours={hours}
      title="Unbooked hours — click to show to-do jobs that fit"
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onClick?.(hours);
      }}
      className={cn(
        "rounded bg-emerald-50 font-semibold text-emerald-700 hover:bg-emerald-100 border border-emerald-200",
        compact ? "px-1 text-[10px] leading-4" : "px-1.5 text-xs"
      )}
    >
      {formatHours(hours)} free
    </button>
  );
}

/**
 * Board drops: the droppable under the pointer wins (so the to-do panel,
 * which is tall, can't steal a drop aimed at a cell next to it — or the other
 * way round); with the pointer over nothing, the nearest, as before.
 */
const boardCollision: CollisionDetection = (args) => {
  const within = pointerWithin(args);
  return within.length > 0 ? within : closestCenter(args);
};

/** Everyone booked on a job, in booking order, once each. */
function bookedNames(bookings: readonly BoardBooking[], staffById: Map<string, StaffMember>) {
  const names: string[] = [];
  for (const b of bookings) {
    const name = b.staff_id ? staffById.get(b.staff_id)?.full_name : null;
    if (name && !names.includes(name)) names.push(name);
  }
  return names.join(", ");
}

// A name cell in the Week grid: pinned to the left edge while the days scroll
// under it, with a soft edge so it reads as floating above them.
const PINNED_NAME =
  "bg-white p-2 flex items-center gap-2 min-w-0 sticky left-0 z-10 shadow-[4px_0_6px_-4px_rgba(0,0,0,0.12)]";

const NO_LEAVE: ScheduleLeave[] = [];

export function TeamScheduleView({
  jobs,
  bookings: initialBookings,
  bookingsReadOnly,
  staff,
  todoJobs,
  todoError,
  leave = NO_LEAVE,
  viewerRole = null,
  viewerId = null,
  overHours = null,
}: {
  jobs: BoardJob[];
  bookings: BoardBooking[];
  /** The bookings were derived from the job windows (job_bookings not in this database yet); moves are refused. */
  bookingsReadOnly: boolean;
  staff: StaffMember[];
  todoJobs: TodoJob[];
  todoError: string | null;
  /** Staff leave around the board's dates (0112); leave_type null = withheld from this viewer. */
  leave?: ScheduleLeave[];
  viewerRole?: string | null;
  /** The signed-in user — the Schedule dialog posts booking notes as them. */
  viewerId?: string | null;
  /**
   * Used vs allowed hours per job (lib/over-hours.ts) — office/admin only;
   * null for a technician, or when the read failed (no badges then).
   */
  overHours?: HoursByJob | null;
}) {
  // Narrowed to the methods lib/bookings.ts uses. Not cosmetic: matching the
  // fully-generic typed client against a structural parameter makes
  // TypeScript give up with TS2589 ("type instantiation is excessively
  // deep"). This says exactly what this component does with the client —
  // insert/update on job_bookings — rather than widening anything to `any`.
  const supabase = createClient() as unknown as BookingWriteClient;
  // Week is the default view (Justin, 19 Oct 2026): the board opens on the
  // whole week, and Day is its own tab beside it rather than a toggle inside
  // one "Team" tab that always reopened on today.
  const [tab, setTab] = useState("week");
  // Every job passed in here already has a scheduled_start (the page query
  // filters that) — jobs with no time yet stay in the general Jobs list
  // until someone schedules them, rather than flooding this board's
  // Unassigned column. The cards are their bookings.
  const [bookings, setBookings] = useState<BoardBooking[]>(initialBookings);
  // The board's jobs and the to-do list are local too: a to-do job dropped on
  // the board joins the board's jobs before the server confirms (and a booking
  // dragged back puts its job on the list). After each such write the page is
  // refreshed, and new props replace all three — what's shown is then what
  // the database holds.
  const [boardJobs, setBoardJobs] = useState<BoardJob[]>(jobs);
  const [todoList, setTodoList] = useState<TodoJob[]>(todoJobs);
  const [seenProps, setSeenProps] = useState({ jobs, initialBookings, todoJobs });
  if (seenProps.jobs !== jobs || seenProps.initialBookings !== initialBookings || seenProps.todoJobs !== todoJobs) {
    setSeenProps({ jobs, initialBookings, todoJobs });
    setBoardJobs(jobs);
    setBookings(initialBookings);
    setTodoList(todoJobs);
  }
  const router = useRouter();
  // Jobs-table writes (to-do listing, status). Its own handle: `supabase`
  // above is narrowed to job_bookings.
  const db = useMemo(() => createClient(), []);
  // The to-do panel beside the board is the office's; technicians never see it.
  const canTodo = viewerRole === "office" || viewerRole === "admin";
  // Open beside the board on a wide screen; behind a toggle on a phone.
  const [todoOpen, setTodoOpen] = useState(false);
  useEffect(() => {
    if (typeof window !== "undefined" && window.matchMedia?.("(min-width: 1024px)").matches) setTodoOpen(true);
  }, []);
  // "Fits in [__] h" — typed, or set by clicking a technician's free hours.
  const [gapInput, setGapInput] = useState("");
  // "Schedule an existing job" — from the toolbar (no prefill) or a
  // technician's day (that technician and day). Office/admin only.
  const [existingFor, setExistingFor] = useState<SchedulePrefill | null>(null);
  const [existingOpen, setExistingOpen] = useState(false);
  function openExisting(prefill: SchedulePrefill | null) {
    setExistingFor(prefill);
    setExistingOpen(true);
  }
  // What the next click on a technician's day does (board-actions.ts): paste a
  // cut booking, paste a copy (until Esc), place a to-do job, or open a
  // searched job's Schedule dialog there. One at a time.
  const [mode, dispatchMode] = useReducer(boardModeReducer<TodoJob>, NO_MODE as BoardMode<TodoJob>);
  // A to-do job picked to place by tapping a cell (the touch path for drag-in).
  const placing = mode.kind === "todo" ? mode.job : null;
  const setPlacing = useCallback(
    (job: TodoJob | null) => dispatchMode(job ? { type: "todo", job } : { type: "clear", kind: "todo" }),
    [],
  );
  // The to-do job being dragged, for the overlay.
  const [activeTodo, setActiveTodo] = useState<TodoJob | null>(null);
  const jobsById = useMemo(() => new Map(boardJobs.map((j) => [j.id, j])), [boardJobs]);
  // The card being dragged, for the overlay.
  const [activeEntry, setActiveEntry] = useState<BoardEntry | null>(null);
  // The job double-clicked (or "Cut") for cut & paste; the next cell clicked
  // receives it. While copying, the booking being copied (highlighted).
  const cut = mode.kind === "cut" || mode.kind === "copy" ? mode.pickup : null;
  const copyingBooking = mode.kind === "copy";
  const setCut = useCallback(
    (pickup: Pickup | null) => dispatchMode(pickup ? { type: "cut", pickup } : { type: "clear", kind: "cut" }),
    [],
  );
  // The booking menu (press and hold / right-click), and the job whose
  // Schedule dialog is open over the board.
  const [menu, setMenu] = useState<{ pickup: Pickup; at: Point } | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  const [scheduleRequest, setScheduleRequest] = useState<{ jobId: string; jobNumber: number; prefill: SchedulePrefill | null } | null>(null);
  // The booking whose edge is being dragged (Week view).
  const [resize, setResize] = useState<ResizeState | null>(null);
  const gesture = useRef<ResizeGesture | null>(null);
  const suppressClickUntil = useRef(0);

  const todayKey = useMemo(() => dateKeyInBusinessTZ(new Date()), []);
  const [selectedDateKey, setSelectedDateKey] = useState(todayKey);
  const viewMode: "day" | "week" = tab === "day" ? "day" : "week";

  // Mouse/pen: drag once moved 6 px (a still, held button opens the menu);
  // touch: the old 200 ms press-and-hold. BoardPointerSensor picks per press.
  const sensors = useSensors(useSensor(BoardPointerSensor));

  const staffById = useMemo(() => new Map(staff.map((s) => [s.id, s])), [staff]);

  // Everything below is derived from bookings/staff/the selected period and
  // was rebuilt on every render — including the one a drag start triggers.
  // Each collection is memoised on its real inputs, and each booking's booked
  // days (lib/scheduling.ts scheduleDays) are worked out once per booking, not
  // once per use: stepping between days or weeks re-buckets without
  // recomputing them.
  const bookingDays = useMemo(() => daysByBooking(bookings), [bookings]);
  const bookingsByJob = useMemo(() => {
    const map = new Map<string, BoardBooking[]>();
    for (const b of bookings) {
      const list = map.get(b.job_id);
      if (list) list.push(b);
      else map.set(b.job_id, [b]);
    }
    return map;
  }, [bookings]);
  // The List tab's days for each job: the union of its bookings' days.
  const jobDays = useMemo(() => {
    const map = new Map<string, ReturnType<typeof jobDaysFromBookings>>();
    for (const job of boardJobs) map.set(job.id, jobDaysFromBookings(bookingsByJob.get(job.id) ?? [], bookingDays));
    return map;
  }, [boardJobs, bookingsByJob, bookingDays]);

  // Read every render, as isTodayInBusinessTZ did, so a board left open past
  // midnight still re-splits today/upcoming on its next render. "Today" is
  // any job with a booking today — a multi-day booking in its second day
  // included.
  const liveTodayKey = dateKeyInBusinessTZ(new Date());
  const { todayJobsLive, upcomingJobsLive } = useMemo(() => {
    const today: BoardJob[] = [];
    const upcoming: BoardJob[] = [];
    for (const job of boardJobs) {
      // Completed jobs are on the Week/Day board (greyed), not in the List's
      // open work — as on the phone, whose List shows open jobs only.
      if (isClosedJob(job)) continue;
      const days = jobDays.get(job.id) ?? [];
      if (days.length === 0) continue;
      (days.some((d) => d.dateKey === liveTodayKey) ? today : upcoming).push(job);
    }
    // Upcoming in order of the job's first booked day, which can differ from
    // the page's scheduled_start order once a booking has been moved here.
    upcoming.sort((a, b) => (jobDays.get(a.id)![0].startIso < jobDays.get(b.id)![0].startIso ? -1 : 1));
    return { todayJobsLive: today, upcomingJobsLive: upcoming };
  }, [boardJobs, jobDays, liveTodayKey]);

  // Week grid — staff (rows) x the 7 days (Mon-Sun) containing
  // selectedDateKey. The day board is the same index over one day.
  const weekKeys = useMemo(() => weekDateKeys(selectedDateKey), [selectedDateKey]);
  const weekKeySet = useMemo(() => new Set(weekKeys), [weekKeys]);
  const visibleKeys = useMemo(
    () => (viewMode === "week" ? weekKeys : [selectedDateKey]),
    [viewMode, weekKeys, selectedDateKey],
  );
  const savedBoard = useMemo(
    () => buildBoardIndex(bookings, jobsById, visibleKeys, bookingDays),
    [bookings, jobsById, visibleKeys, bookingDays],
  );
  // While an edge is dragged (and while its save is in flight), the board
  // draws that booking with its PREVIEW window: chips appear on days live,
  // dropped days fade, and the row's hours follow. Nothing is written until
  // release. A preview that isn't valid (e.g. past the 366-day cap) draws the
  // booking as it was; the banner says why.
  const resizePlan: ResizePlan | null = useMemo(
    () => (resize ? planBookingResize(resize.booking, resize.edge, resize.delta) : null),
    [resize],
  );
  const preview = useMemo(
    () =>
      resize && resizePlan?.ok
        ? buildResizePreviewIndex(bookings, jobsById, visibleKeys, bookingDays, resize.booking, resizePlan.window)
        : null,
    [resize, resizePlan, bookings, jobsById, visibleKeys, bookingDays],
  );
  const board = preview?.index ?? savedBoard;
  const shownDays = useMemo(
    () => (resize && preview ? new Map(bookingDays).set(resize.booking.id, preview.previewDays) : bookingDays),
    [resize, preview, bookingDays],
  );

  // Leave on the days showing, and the bookings that sit on someone's leave
  // (from today on — past days need no reassigning). Leave never moves, so
  // the resize preview doesn't change it.
  const leaveIndex = useMemo(() => buildLeaveIndex(leave, visibleKeys), [leave, visibleKeys]);
  // A completed job's bookings are history: never "Needs reassigning".
  const reassign = useMemo(
    () =>
      bookingsNeedingReassignment(
        bookings.filter((b) => {
          const job = jobsById.get(b.job_id);
          return !job || !isClosedJob(job);
        }),
        leave,
        todayKey,
      ),
    [bookings, jobsById, leave, todayKey],
  );
  const overOn = (entry: BoardEntry): OverHours | null => (overHours ? bookingOverHours(entry.booking, overHours) : null);
  const closedOn = (entry: BoardEntry) => isClosedJob(entry.job);
  // The header's "N jobs over their allowed hours": every job on the board
  // (open, and completed in the board's dates), worst first.
  const overJobs = useMemo<OverHoursJob[]>(() => {
    if (!overHours) return [];
    const byId = new Map(boardJobs.map((j) => [j.id, j]));
    return jobsOverHours(boardJobs.map((j) => j.id), overHours)
      .flatMap(({ jobId, items }) => {
        const job = byId.get(jobId);
        return job ? [{ id: job.id, job_number: job.job_number, title: job.title, status: job.status, items }] : [];
      })
      .sort((a, b) => {
        const by = (j: OverHoursJob) => Math.max(...j.items.map((i) => i.usedHours - i.allowedHours));
        return by(b) - by(a) || a.job_number - b.job_number;
      });
  }, [overHours, boardJobs]);
  const reassignOn = (entry: BoardEntry) => reassign.get(entry.booking.id)?.some((c) => c.dateKey === entry.day.dateKey) ?? false;
  const leaveOn = (staffId: string, dateKey: string) => leaveIndex.get(staffId)?.get(dateKey) ?? [];
  // The leave day whose details are open, and a pending "book anyway?" question.
  const [openLeave, setOpenLeave] = useState<LeaveDay | null>(null);
  const [confirm, setConfirm] = useState<{ title: string; lines: string[]; action: string; resolve: (ok: boolean) => void } | null>(null);
  const askConfirm = (title: string, lines: string[], action: string) =>
    new Promise<boolean>((resolve) => setConfirm({ title, lines, action, resolve }));
  // A to-do job dropped on a day asks which cost centre the booking is for
  // (19 Nov 2026 — every booking asks).
  const [costCentreAsk, setCostCentreAsk] = useState<(CostCentreRequest & { resolve: (p: PickedCostCentre | null) => void }) | null>(null);
  const askCostCentre = (req: CostCentreRequest) =>
    new Promise<PickedCostCentre | null>((resolve) => setCostCentreAsk({ ...req, resolve }));
  const closeCostCentre = (picked: PickedCostCentre | null) => {
    costCentreAsk?.resolve(picked);
    setCostCentreAsk(null);
  };
  const closeConfirm = (ok: boolean) => {
    confirm?.resolve(ok);
    setConfirm(null);
  };

  // Booked hours per technician over the period showing — one day, or the
  // week's total. `periodHours` is what's drawn (preview included);
  // `savedHours` orders the rows, so they don't jump about under a resize.
  const periodHours = useMemo(() => hoursByStaff(board), [board]);
  const savedHours = useMemo(() => hoursByStaff(savedBoard), [savedBoard]);

  // Busiest first (most booked hours in whichever period is showing), then
  // everyone else so it's obvious at a glance who's free and could take on
  // more work.
  const sortedStaff = useMemo(
    () =>
      [...staff].sort((a, b) => {
        const diff = (savedHours.get(b.id) ?? 0) - (savedHours.get(a.id) ?? 0);
        if (diff !== 0) return diff;
        return a.full_name.localeCompare(b.full_name);
      }),
    [staff, savedHours],
  );

  // Day view's timeline: 6:00–19:00, widened to whole hours to fit any block
  // that starts earlier or ends later (the phone's rule — dayTimelineHours).
  const dayRange = useMemo(() => {
    const days = [];
    for (const byDay of board.byStaff.values()) for (const e of byDay.get(selectedDateKey) ?? []) days.push(e.day);
    for (const e of board.unassigned.get(selectedDateKey) ?? []) days.push(e.day);
    return dayTimelineHours(days, selectedDateKey);
  }, [board, selectedDateKey]);
  const dayTimelineWidth = (dayRange.endHour - dayRange.startHour) * WEB_HOUR_WIDTH;

  const cutJob = useMemo(() => {
    const booking = mode.kind === "cut" ? bookings.find((b) => b.id === mode.pickup.bookingId) : undefined;
    return booking ? jobsById.get(booking.job_id) ?? null : null;
  }, [mode, bookings, jobsById]);
  const isSelectedToday = selectedDateKey === todayKey;
  const isCurrentPeriod = viewMode === "week" ? weekKeySet.has(todayKey) : isSelectedToday;
  const selectedDateLabel = useMemo(
    () =>
      formatDate(anchorForDateKey(selectedDateKey), {
        weekday: "long",
        day: "numeric",
        month: "long",
      }),
    [selectedDateKey],
  );
  const weekRangeLabel = useMemo(() => formatWeekRangeLabel(weekKeys), [weekKeys]);

  // Shift held = ADD a copy of the booking for the target technician instead
  // of moving it to them. Tracked from the keyboard because a drop event does not carry
  // modifier keys reliably across pointer and touch sensors.
  const shiftHeld = useRef(false);
  useEffect(() => {
    const down = (e: KeyboardEvent) => { if (e.key === "Shift") shiftHeld.current = true; };
    const up = (e: KeyboardEvent) => { if (e.key === "Shift") shiftHeld.current = false; };
    const blur = () => { shiftHeld.current = false; };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", blur);
    };
  }, []);

  // Esc leaves whichever mode is on (cut, copy, placing, scheduling).
  const modeOn = mode.kind !== "none";
  useEffect(() => {
    if (!modeOn) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") dispatchMode({ type: "clear" });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [modeOn]);

  const nameOf = useCallback(
    (staffId: string | null) => (staffId ? staffById.get(staffId)?.full_name ?? "Technician" : "Unassigned"),
    [staffById],
  );

  function describeMove(job: BoardJob, patch: BookingPatch, source: BoardCell, target: BoardCell) {
    const changes: string[] = [];
    if (patch.staff_id !== undefined) {
      changes.push(
        target.staffId
          ? `${source.staffId ? `${nameOf(source.staffId)}'s booking` : "booking"} moved to ${nameOf(target.staffId)}`
          : `${nameOf(source.staffId)}'s booking unassigned`,
      );
    }
    if (patch.starts_at) changes.push(`moved to ${formatDate(anchorForDateKey(target.dateKey), { weekday: "short", day: "numeric", month: "short" })}`);
    return `#${job.job_number} ${changes.join(" and ")}`;
  }

  /** Say whether Google heard about it — see the toast rule in moveBooking. */
  function announce(what: string, calendarSynced: boolean) {
    // A re-date the calendar never heard about is the state that used to let
    // the poll write the old time back. Saying so is the difference between
    // a user retrying now and finding the booking moved back tomorrow.
    if (calendarSynced) toast.success(what);
    else toast.warning(`${what} — Google Calendar not updated`);
  }

  /**
   * The one move both gestures make — a drop and a paste land here, in either
   * view. A plain move changes the dragged BOOKING only (planBoardMove): its
   * technician becomes the target row's, and it starts on the target day
   * when that day differs. Shift adds a copy for the target technician
   * instead (planBoardAdd). One row written either way, so there is no
   * half-done state to unwind — the old crew-then-dates pair needed one.
   */
  async function moveBooking(bookingId: string, source: BoardCell, target: BoardCell, kind: "move" | "add" = "move") {
    const booking = bookings.find((b) => b.id === bookingId);
    const job = booking ? jobsById.get(booking.job_id) : undefined;
    // A Shift-drop copy still waiting for its real id cannot be moved yet.
    if (!booking || !job || bookingId.startsWith("pending:")) return;
    // Its edge is being dragged or saved; a move now would race that write.
    if (resize?.booking.id === bookingId) return;
    if (bookingsReadOnly) {
      toast.error("Bookings aren't set up in this database yet — change this job from its Schedule dialog.");
      return;
    }

    if (kind === "add") {
      if (isClosedJob(job)) {
        toast.error(`#${job.job_number} is ${job.status} — it can't be scheduled.`);
        return;
      }
      const copy = planBoardAdd(booking, source, target, bookingsByJob.get(job.id) ?? []);
      // Unassigned, or they already have exactly this booking.
      const refusal = copyRefusal(target, copy, nameOf(target.staffId));
      if (refusal || !copy) {
        toast.error(refusal ?? "Nothing to copy.");
        return;
      }
      // Already booked on other work then: their call, never silent.
      const clashes = newBookingClashes(copy, bookings);
      if (clashes.length > 0) {
        const ok = await askConfirm(
          `${nameOf(target.staffId)} is already booked then`,
          [
            `#${job.job_number} — ${job.title}`,
            ...clashes.map((c) => {
              const j = jobsById.get(c.job_id);
              return `Already on #${j?.job_number ?? "?"} ${j?.title ?? ""}`.trim();
            }),
          ],
          "Book anyway",
        );
        if (!ok) return;
      }
      if (!(await okToBookOverLeave(job, copy))) return;
      // A stand-in until the insert returns the real row (and its id).
      const tempId = `pending:${bookingId}:${target.staffId}:${Date.now()}`;
      setBookings((prev) => [...prev, { ...copy, id: tempId, cost_center_name: booking.cost_center_name }]);
      const inserted = await insertBookings(supabase, [copy]);
      if (!inserted.ok) {
        setBookings((prev) => prev.filter((b) => b.id !== tempId));
        toast.error(inserted.error);
        return;
      }
      const real = inserted.rows[0];
      // The insert's answer has no note column (BOOKING_COLUMNS); the copy's is the one written.
      setBookings((prev) => prev.map((b) => (b.id === tempId ? { ...real, note: copy.note ?? null, cost_center_name: booking.cost_center_name } : b)));
      announce(`#${job.job_number} booked for ${nameOf(target.staffId)} too`, await pushJobToCalendar(job.id));
      return;
    }

    if (isClosedJob(job)) {
      toast.error(closedMoveMessage(job));
      return;
    }
    const patch = planBoardMove(booking, source, target);
    if (!patch) return; // dropped back where it came from
    if (!(await okToBookOverLeave(job, applyBoardMove(booking, patch)))) return;

    setBookings((prev) => prev.map((b) => (b.id === bookingId ? applyBoardMove(b, patch) : b)));
    const result = await updateBooking(supabase, bookingId, patch);
    if (!result.ok) {
      setBookings((prev) => prev.map((b) => (b.id === bookingId ? booking : b)));
      toast.error(result.error);
      return;
    }
    // A technician-only move still pushes — the event's title names the
    // technician (lib/calendar-event.ts), and see "WHY BOTH DRAG KINDS PUSH"
    // in lib/schedule-dispatch.ts.
    announce(describeMove(job, patch, source, target), await pushJobToCalendar(job.id));
  }

  /**
   * Booking someone on a day they are on leave is the office's call, but
   * never silent: ask first. True when no leave is in the way or the office
   * chose "Book anyway".
   */
  async function okToBookOverLeave(job: BoardJob, after: { staff_id: string | null; starts_at: string; ends_at: string | null; daily: boolean }) {
    const hits = bookingLeaveConflicts(after, leave, dateKeyInBusinessTZ(new Date()));
    if (hits.length === 0) return true;
    const name = nameOf(after.staff_id);
    return askConfirm(`${name} isn't available then`, [`#${job.job_number} — ${job.title}`, describeLeaveConflicts(name, hits)], "Book anyway");
  }

  // Paste: a click on any cell while a booking is cut (Shift = add a copy, as a Shift-drop).
  function placeCut(targetId: string) {
    if (mode.kind !== "cut") return;
    const pickup = mode.pickup;
    dispatchMode({ type: "picked" });
    const target = parseBoardTarget(targetId, selectedDateKey);
    if (target) void moveBooking(pickup.bookingId, pickup.source, target, shiftHeld.current ? "add" : "move");
  }

  // Copy mode: every click on a day pastes another copy there (the Shift-drop
  // rules — planBoardAdd), until Esc or Done.
  function pasteCopy(targetId: string) {
    if (mode.kind !== "copy") return;
    const target = parseBoardTarget(targetId, selectedDateKey);
    if (target) void moveBooking(mode.pickup.bookingId, mode.pickup.source, target, "add");
  }

  // Schedule mode: the searched job's Schedule dialog opens on the clicked
  // technician and day (Unassigned = a booking with nobody yet).
  function placeSchedule(targetId: string) {
    if (mode.kind !== "schedule") return;
    const job = mode.job;
    const target = parseBoardTarget(targetId, selectedDateKey);
    if (!target) return;
    dispatchMode({ type: "picked" });
    openScheduleDialog(job, { staffId: target.staffId, dateKey: target.dateKey });
  }

  function openScheduleDialog(job: ScheduleJobPick, prefill: SchedulePrefill | null) {
    if (!viewerId) return;
    setScheduleRequest({ jobId: job.id, jobNumber: job.job_number, prefill });
  }

  /** A job picked in the search: straight to its dialog when the day is known (the "+"), else pick a day. */
  function pickedFromSearch(job: ScheduleJobPick) {
    if (existingFor) openScheduleDialog(job, existingFor);
    else dispatchMode({ type: "schedule", job: { id: job.id, job_number: job.job_number, title: job.title } });
  }

  // -------------------------------------------------------------------------
  // The booking menu
  // -------------------------------------------------------------------------

  const openMenu = useCallback(
    (pickup: Pickup, at: Point) => {
      if (modeOn || resize) return;
      setMenu({ pickup, at });
    },
    [modeOn, resize],
  );

  const menuBooking = menu ? bookings.find((b) => b.id === menu.pickup.bookingId) : undefined;
  const menuJob = menuBooking ? jobsById.get(menuBooking.job_id) : undefined;

  function onMenuAction(action: BookingMenuAction) {
    if (!menu || !menuBooking || !menuJob) return;
    const pickup = menu.pickup;
    switch (action) {
      case "copy":
        dispatchMode({ type: "copy", pickup, jobNumber: menuJob.job_number });
        return;
      case "cut":
        setCut(pickup);
        return;
      case "schedule":
        openScheduleDialog(menuJob, null);
        return;
      case "open":
        router.push(`/dashboard/jobs/${menuJob.id}`);
        return;
      case "todo":
        void dragOut(pickup);
        return;
    }
  }

  function handleDragStart(event: DragStartEvent) {
    // A held mouse button that then moves is a drag, not the menu. (On touch
    // the drag starts first and the menu may follow; handleDragMove closes it
    // once the finger moves on.)
    if ((event.activatorEvent as PointerEvent | null)?.pointerType !== "touch") setMenu(null);
    dispatchMode({ type: "clear" });
    const data = event.active.data.current as { kind?: string; job?: TodoJob; entry?: BoardEntry } | undefined;
    if (data?.kind === "todo") {
      setActiveTodo(data.job ?? null);
      return;
    }
    setActiveEntry(data?.entry ?? null);
  }

  function handleDragMove(event: DragMoveEvent) {
    const pointerType = (event.activatorEvent as PointerEvent | null)?.pointerType;
    if (menu && movedBeyond({ x: 0, y: 0 }, event.delta, holdTolerance(pointerType))) setMenu(null);
  }

  function handleDragEnd(event: DragEndEvent) {
    setActiveEntry(null);
    setActiveTodo(null);
    const { active, over } = event;
    if (!over) return;
    const data = active.data.current as ({ kind?: string; job?: TodoJob } & Partial<Pickup>) | undefined;
    if (data?.kind === "todo") {
      const target = parseBoardTarget(over.id as string, selectedDateKey);
      if (data.job && target) void dropTodo(data.job, target);
      return;
    }
    if (over.id === TODO_PANEL_DROP_ID) {
      if (data?.bookingId && data.source) void dragOut({ bookingId: data.bookingId, source: data.source });
      return;
    }
    const target = parseBoardTarget(over.id as string, selectedDateKey);
    if (!data?.bookingId || !data.source || !target) return;
    void moveBooking(data.bookingId, data.source, target, shiftHeld.current ? "add" : "move");
  }

  // -------------------------------------------------------------------------
  // The to-do list beside the board
  // -------------------------------------------------------------------------

  /** A to-do job as a board job, until the refresh brings the real row. */
  function boardJobFromTodo(job: TodoJob): BoardJob {
    return {
      id: job.id,
      job_number: job.job_number,
      title: job.title,
      status: job.status,
      scheduled_start: null,
      scheduled_end: null,
      assigned_to: null,
      crew: [],
      customers: job.customer_name ? { name: job.customer_name } : null,
      sites: job.suburb ? { suburb: job.suburb } : null,
    };
  }

  /**
   * Drag in: a to-do job dropped (or placed by tap) on a technician's day —
   * or Unassigned. One booking (planTodoDrop), the same guards as every other
   * board write: closed jobs and a read-only board refused, "already booked
   * then" and leave asked first, the card shown as pending until the insert
   * returns, and taken back off on a refusal. Then the job comes off the
   * list (and a pending job becomes scheduled) and Google hears.
   */
  async function dropTodo(job: TodoJob, target: BoardCell) {
    setPlacing(null);
    if (bookingsReadOnly) {
      toast.error("Bookings aren't set up in this database yet — schedule this job from its Schedule dialog.");
      return;
    }
    if (isClosedJob(job)) {
      toast.error(`#${job.job_number} is ${job.status} — it can't be scheduled.`);
      return;
    }
    const estimate = todoHours(job.estimated_hours, job.po_allocated_hours).hours;
    const dayBlocks = target.staffId
      ? bookings.filter((b) => b.staff_id === target.staffId).flatMap((b) => bookingDays.get(b.id) ?? [])
      : [];
    const planned = planTodoDrop({ jobId: job.id, staffId: target.staffId, dateKey: target.dateKey, estimateHours: estimate, dayBlocks });
    const whenText = formatDate(anchorForDateKey(target.dateKey), { weekday: "short", day: "numeric", month: "short" });
    const timeText = planned.all_day ? "All day" : `${formatTime(planned.starts_at)}–${planned.ends_at ? formatTime(planned.ends_at) : ""}`;
    const costCentre = await askCostCentre({
      jobId: job.id,
      title: `Book #${job.job_number} — ${job.title}`,
      detail: `${target.staffId ? nameOf(target.staffId) : "Unassigned"} on ${whenText}, ${timeText}. Which cost centre is this booking for?`,
    });
    if (!costCentre) return;
    const insert = { ...planned, cost_center_id: costCentre.id };
    const asBoardJob = jobsById.get(job.id) ?? boardJobFromTodo(job);
    const clashes = newBookingClashes(insert, bookings);
    if (clashes.length > 0) {
      const ok = await askConfirm(
        `${nameOf(target.staffId)} is already booked then`,
        [
          `#${job.job_number} — ${job.title}`,
          ...clashes.map((c) => {
            const j = jobsById.get(c.job_id);
            return `Already on #${j?.job_number ?? "?"} ${j?.title ?? ""}`.trim();
          }),
        ],
        "Book anyway",
      );
      if (!ok) return;
    }
    if (!(await okToBookOverLeave(asBoardJob, insert))) return;

    const tempId = `pending:todo:${job.id}:${Date.now()}`;
    setBoardJobs((prev) => (prev.some((j) => j.id === job.id) ? prev : [...prev, asBoardJob]));
    setBookings((prev) => [...prev, { ...insert, id: tempId, cost_center_name: costCentre.name }]);
    setTodoList((prev) => prev.filter((j) => j.id !== job.id));
    const inserted = await insertBookings(supabase, [insert]);
    if (!inserted.ok) {
      setBookings((prev) => prev.filter((b) => b.id !== tempId));
      setTodoList((prev) => (prev.some((j) => j.id === job.id) ? prev : [...prev, job]));
      toast.error(`#${job.job_number} was not booked — ${inserted.error}`);
      return;
    }
    const real = inserted.rows[0];
    setBookings((prev) => prev.map((b) => (b.id === tempId ? { ...real, note: null, cost_center_name: costCentre.name } : b)));
    // 0067's trigger already took it off the list when 0079 derived the new
    // scheduled_start; this also covers a job listed while it had a start,
    // and moves a pending job to scheduled (the Schedule dialog's rule).
    const patch = jobPatchAfterDrop(job.status);
    const { error: jobError, count } = await db.from("jobs").update(patch, { count: "exact" }).eq("id", job.id);
    if (jobError || count === 0) toast.warning(`#${job.job_number} booked — but its status/to-do flag could not be updated`);
    if (patch.status) setBoardJobs((prev) => prev.map((j) => (j.id === job.id ? { ...j, status: patch.status! } : j)));
    const when = formatDate(anchorForDateKey(target.dateKey), { weekday: "short", day: "numeric", month: "short" });
    announce(`#${job.job_number} booked for ${nameOf(target.staffId)} on ${when}`, await pushJobToCalendar(job.id));
    router.refresh();
  }

  /**
   * Drag out: a booking dropped on the to-do panel (or cut, then the panel
   * clicked). Deletes THAT booking only — never the rest of the crew's — and,
   * when it was the job's last, puts the job back on the list (planDragOut).
   * Always asks first.
   */
  async function dragOut(pickup: Pickup) {
    dispatchMode({ type: "clear", kind: "cut" });
    const booking = bookings.find((b) => b.id === pickup.bookingId);
    const job = booking ? jobsById.get(booking.job_id) : undefined;
    if (!booking || !job) return;
    if (resize?.booking.id === booking.id) return;
    if (bookingsReadOnly) {
      toast.error("Bookings aren't set up in this database yet — change this job from its Schedule dialog.");
      return;
    }
    const plan = planDragOut(booking, bookingsByJob.get(job.id) ?? [], job.status);
    if (plan.kind === "refuse") {
      toast.error(plan.reason);
      return;
    }
    const days = bookingDays.get(booking.id) ?? [];
    const when =
      days.length > 1
        ? formatDateKeyRange(days[0].dateKey, days[days.length - 1].dateKey)
        : formatDate(anchorForDateKey(days[0]?.dateKey ?? pickup.source.dateKey), { weekday: "long" });
    const words = describeDragOut(plan, { jobNumber: job.job_number, who: booking.staff_id ? nameOf(booking.staff_id) : null, when });
    if (!(await askConfirm(words.title, [`${job.title}. ${words.detail}`], words.action))) return;

    setBookings((prev) => prev.filter((b) => b.id !== booking.id));
    const removed = await deleteBooking(supabase, booking.id);
    if (!removed.ok) {
      setBookings((prev) => (prev.some((b) => b.id === booking.id) ? prev : [...prev, booking]));
      toast.error(`#${job.job_number} was not changed — ${removed.error}`);
      return;
    }
    const calendar = pushJobToCalendar(job.id);
    if (plan.kind === "list") {
      // One statement: back to pending (when it was scheduled) and listed.
      // 0079 already cleared the job's scheduled_start with the delete, so
      // 0067's trigger lets the listing stand; it stamps the time and lister.
      const { data, error: listError, count } = await db
        .from("jobs")
        .update({ todo_listed_at: new Date().toISOString(), ...(plan.status ? { status: plan.status } : null) }, { count: "exact" })
        .eq("id", job.id)
        .select("todo_listed_at, estimated_hours, priority");
      const row = data?.[0];
      if (listError || count === 0 || !row?.todo_listed_at) {
        announce(`#${job.job_number} taken off the board — but it could not be put on the to-do list`, await calendar);
      } else {
        const listedAt = row.todo_listed_at;
        setTodoList((prev) => [
          ...prev.filter((j) => j.id !== job.id),
          {
            id: job.id,
            job_number: job.job_number,
            title: job.title,
            priority: row.priority ?? "normal",
            status: plan.status ?? job.status,
            todo_listed_at: listedAt,
            estimated_hours: row.estimated_hours,
            po_allocated_hours: null,
            customer_name: job.customers?.name ?? null,
            suburb: job.sites?.suburb ?? null,
          },
        ]);
        if (plan.status) setBoardJobs((prev) => prev.map((j) => (j.id === job.id ? { ...j, status: plan.status! } : j)));
        announce(`#${job.job_number} is back on the to-do list`, await calendar);
      }
    } else {
      announce(`#${job.job_number}: ${booking.staff_id ? `${nameOf(booking.staff_id)}'s` : "the unassigned"} booking removed`, await calendar);
    }
    router.refresh();
  }

  /** The ✕ on a to-do row: off the list, nothing else changes. */
  async function removeFromTodo(job: TodoJob) {
    setTodoList((prev) => prev.filter((j) => j.id !== job.id));
    if (placing?.id === job.id) setPlacing(null);
    const { error: removeError, count } = await db
      .from("jobs")
      .update({ todo_listed_at: null, todo_listed_by: null }, { count: "exact" })
      .eq("id", job.id);
    if (removeError || count === 0) {
      setTodoList((prev) => (prev.some((j) => j.id === job.id) ? prev : [...prev, job]));
      toast.error(`Couldn't take #${job.job_number} off the to-do list`);
      return;
    }
    toast.success(`#${job.job_number} taken off the to-do list`);
    router.refresh();
  }

  // Tap-to-place: a click on any cell while a to-do job is picked.
  function placeTodo(targetId: string) {
    if (!placing) return;
    const job = placing;
    setPlacing(null);
    const target = parseBoardTarget(targetId, selectedDateKey);
    if (target) void dropTodo(job, target);
  }

  /** A technician's free hours on a day (office/admin only). */
  function gapFor(staffId: string, dateKey: string): DayGap | undefined {
    if (!canTodo) return undefined;
    return unbookedHours({
      dateKey,
      todayKey,
      bookedHours: savedBoard.hours.get(staffId)?.get(dateKey) ?? 0,
      leaveDays: leaveOn(staffId, dateKey),
    });
  }

  /** Clicking a gap: show the to-do jobs that fit it. */
  function filterToGap(hours: number) {
    setGapInput(String(hours));
    setTodoOpen(true);
  }

  const onPick =
    mode.kind === "cut" ? placeCut : mode.kind === "copy" ? pasteCopy : mode.kind === "todo" ? placeTodo : mode.kind === "schedule" ? placeSchedule : undefined;
  // The hover card (mouse rest / keyboard focus on a booking). None while a
  // booking is dragged or resized, the booking menu is open, or a pick mode
  // waits for a click — it would sit over the day you're aiming for.
  const hoverCard = useHoverCard<BoardEntry>(!!activeEntry || !!activeTodo || !!resize || !!menu || !!onPick);
  const hoverCardId = useHoverCardId();
  const hoverFor = (entry: BoardEntry) =>
    hoverHandlers(
      hoverCard,
      entry,
      hoverCard.target?.item.booking.id === entry.booking.id && hoverCard.target.item.day.dateKey === entry.day.dateKey ? hoverCardId : undefined,
    );

  // What every placed card is handed for cut/copy/menu/hover.
  const cardWiring = {
    cut,
    copying: copyingBooking,
    pickActive: !!onPick,
    onCut: setCut,
    onMenu: canTodo && viewerId ? openMenu : undefined,
    hoverFor,
  };

  /** The name tag for a tile: its row's technician, plus whoever else is on that job that day. */
  function tagFor(entry: BoardEntry): TileTag {
    return {
      own: entry.booking.staff_id ? nameOf(entry.booking.staff_id) : null,
      others: otherStaffOnJobDay(entry, bookingsByJob.get(entry.job.id) ?? [], shownDays).map(nameOf),
    };
  }

  // -------------------------------------------------------------------------
  // Edge resize (Week view)
  // -------------------------------------------------------------------------

  function startResize(entry: BoardEntry, edge: ResizeEdge, e: React.PointerEvent<HTMLElement>) {
    if (resize) return;
    const reason = bookingsReadOnly
      ? "Bookings aren't set up in this database yet — change this job from its Schedule dialog."
      : resizeBlockedReason(entry.job, entry.booking);
    if (reason) {
      toast.error(reason);
      return;
    }
    const handle = e.currentTarget;
    // One day = one column of the week grid (plus its 1px gap).
    const cell = handle.closest<HTMLElement>("[data-week-cell]");
    const scroller = handle.closest<HTMLElement>("[data-board-scroller]");
    try {
      handle.setPointerCapture(e.pointerId);
    } catch {
      // Not capturable (pointer already gone) — the window listeners still follow it.
    }
    gesture.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      lastX: e.clientX,
      dayWidth: Math.max(40, (cell?.getBoundingClientRect().width ?? 120) + 1),
      scroller,
      startScroll: scroller?.scrollLeft ?? 0,
    };
    dispatchMode({ type: "clear" });
    setMenu(null);
    setResize({ booking: entry.booking, job: entry.job, edge, delta: 0, phase: "dragging", conflicts: [], leaveConflicts: [] });
  }

  /** Release: nothing changed → nothing; a clash → ask; otherwise save. */
  function finishResize(current: ResizeState, delta: number) {
    const plan = planBookingResize(current.booking, current.edge, delta);
    if (!plan.ok) {
      setResize(null);
      toast.error(plan.error);
      return;
    }
    if (!plan.changed) {
      setResize(null);
      return;
    }
    const conflicts = resizeConflicts(current.booking, plan.window, bookings, jobsById);
    // Leave on a day the stretch ADDS (days it already had are flagged on the board already).
    const had = new Set(bookingDaysForLeave(current.booking).map((d) => d.dateKey));
    const leaveConflicts = bookingLeaveConflicts({ ...current.booking, ...plan.window }, leave, todayKey).filter((c) => !had.has(c.dateKey));
    if (conflicts.length > 0 || leaveConflicts.length > 0) {
      setResize({ ...current, delta, phase: "confirm", conflicts, leaveConflicts });
      return;
    }
    void saveResize({ ...current, delta });
  }

  /**
   * Write the new window and only then call it done. Until the server answers
   * the chips stay on the previewed days, pulsing; a refusal (RLS, a
   * completed-job block on the server, the network) snaps them back to the
   * old days with the reason. Then Google Calendar is told, as after a move.
   */
  async function saveResize(current: ResizeState) {
    const plan = planBookingResize(current.booking, current.edge, current.delta);
    if (!plan.ok || !plan.changed) {
      setResize(null);
      return;
    }
    setResize({ ...current, phase: "saving", conflicts: [], leaveConflicts: [] });
    const result = await updateBooking(supabase, current.booking.id, plan.window);
    if (!result.ok) {
      setResize(null);
      toast.error(`#${current.job.job_number} was not changed — ${result.error}`);
      return;
    }
    setBookings((prev) => prev.map((b) => (b.id === current.booking.id ? { ...b, ...plan.window } : b)));
    setResize(null);
    const who = current.booking.staff_id ? `${nameOf(current.booking.staff_id)}'s booking` : "booking";
    const days = scheduleDays(bookingWindow(plan.window)).length;
    announce(
      `#${current.job.job_number} ${who} now ${formatDateKeyRange(plan.startKey, plan.endKey)} (${days} day${days === 1 ? "" : "s"})`,
      await pushJobToCalendar(current.job.id),
    );
  }

  // Read by the window listeners below, which are attached once per drag.
  const resizeRef = useRef(resize);
  resizeRef.current = resize;
  const finishRef = useRef(finishResize);
  finishRef.current = finishResize;
  const resizing = resize?.phase === "dragging";

  // Follow the pointer from the window, not the handle: the chip under it can
  // unmount mid-drag as the preview redraws. Esc or a cancelled pointer (the
  // OS took the touch) snaps back. Near the grid's edges it auto-scrolls.
  useEffect(() => {
    if (!resizing) return;
    let frame = 0;
    const update = () => {
      const g = gesture.current;
      if (!g) return;
      const delta = gestureDelta(g);
      setResize((r) => (r && r.phase === "dragging" && r.delta !== delta ? { ...r, delta } : r));
    };
    const tick = () => {
      const g = gesture.current;
      if (g?.scroller) {
        const rect = g.scroller.getBoundingClientRect();
        let step = 0;
        if (g.lastX < rect.left + AUTO_SCROLL_EDGE_PX) step = -AUTO_SCROLL_STEP_PX;
        else if (g.lastX > rect.right - AUTO_SCROLL_EDGE_PX) step = AUTO_SCROLL_STEP_PX;
        if (step !== 0) {
          g.scroller.scrollLeft += step;
          update();
        }
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    const end = () => {
      gesture.current = null;
      // The click that follows a pointerup must not open a job or paste.
      suppressClickUntil.current = performance.now() + 400;
    };
    const onMove = (e: PointerEvent) => {
      const g = gesture.current;
      if (!g || e.pointerId !== g.pointerId) return;
      e.preventDefault();
      g.lastX = e.clientX;
      update();
    };
    const onUp = (e: PointerEvent) => {
      const g = gesture.current;
      if (!g || e.pointerId !== g.pointerId) return;
      g.lastX = e.clientX;
      const delta = gestureDelta(g);
      end();
      const current = resizeRef.current;
      if (current?.phase === "dragging") finishRef.current(current, delta);
    };
    const onCancel = (e: PointerEvent) => {
      const g = gesture.current;
      if (!g || e.pointerId !== g.pointerId) return;
      end();
      setResize(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      end();
      setResize(null);
    };
    window.addEventListener("pointermove", onMove, { passive: false });
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    window.addEventListener("keydown", onKey);
    const { cursor, userSelect } = document.body.style;
    document.body.style.cursor = "ew-resize";
    document.body.style.userSelect = "none";
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      window.removeEventListener("keydown", onKey);
      document.body.style.cursor = cursor;
      document.body.style.userSelect = userSelect;
    };
  }, [resizing]);

  // Swallows the one click a resize's release produces (capture phase, so it
  // never reaches a job link or a paste target).
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (performance.now() < suppressClickUntil.current) {
        suppressClickUntil.current = 0;
        e.preventDefault();
        e.stopPropagation();
      }
    };
    window.addEventListener("click", onClick, true);
    return () => window.removeEventListener("click", onClick, true);
  }, []);

  /**
   * Which edge handles a week chip shows. Normally the booking's outer edges
   * (first day's chip: left; last day's: right). None on a closed job, a
   * read-only board or a booking still saving. During a resize only the
   * handle being dragged stays, on the chip it was grabbed from — kept
   * mounted so the pointer it captured is never orphaned.
   */
  function handlesFor(entry: BoardEntry): ChipHandles | null {
    if (resize) {
      if (resize.phase !== "dragging" || resize.booking.id !== entry.booking.id) return null;
      const original = bookingDays.get(resize.booking.id) ?? [];
      const grabbed = resize.edge === "start" ? original[0] : original[original.length - 1];
      if (!grabbed || grabbed.dateKey !== entry.day.dateKey) return null;
      return { start: resize.edge === "start", end: resize.edge === "end" };
    }
    if (bookingsReadOnly || isClosedJob(entry.job) || entry.booking.id.startsWith("pending:")) return null;
    return { start: entry.dayNumber === 1, end: entry.dayNumber === entry.dayCount };
  }

  function resizeStateFor(entry: BoardEntry): ChipResizeState {
    if (!resize || resize.booking.id !== entry.booking.id) return null;
    if (preview?.droppedDayKeys.has(entry.day.dateKey)) return "removing";
    return resize.phase === "saving" ? "saving" : "preview";
  }

  return (
    <Tabs value={tab} onValueChange={(v) => typeof v === "string" && setTab(v)}>
      <TabsList variant="line">
        <TabsTrigger value="week" className="gap-1.5"><CalendarRange className="w-3.5 h-3.5" />Week</TabsTrigger>
        <TabsTrigger value="day" className="gap-1.5"><CalendarDays className="w-3.5 h-3.5" />Day</TabsTrigger>
        <TabsTrigger value="list" className="gap-1.5"><LayoutList className="w-3.5 h-3.5" />List</TabsTrigger>
        <TabsTrigger value="todo" className="gap-1.5">
          <ListTodo className="w-3.5 h-3.5" />To-do list{todoList.length > 0 ? ` (${todoList.length})` : ""}
        </TabsTrigger>
      </TabsList>

      {/* Week and Day share one board; `viewMode` follows the tab. Not a
          TabsContent, so switching between them keeps the board mounted. */}
      {(tab === "week" || tab === "day") && (
      <div className="mt-4">
        <OverHoursSummary jobs={overJobs} />
        <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="icon"
              aria-label={viewMode === "week" ? "Previous week" : "Previous day"}
              onClick={() => setSelectedDateKey((k) => shiftDateKey(k, viewMode === "week" ? -7 : -1))}
            >
              <ChevronLeft className="w-4 h-4" />
            </Button>
            <p className="text-sm font-medium text-slate-900 min-w-[180px] text-center">
              {viewMode === "week" ? weekRangeLabel : selectedDateLabel}
              {viewMode === "day" && isSelectedToday && <span className="text-blue-600"> · Today</span>}
            </p>
            <Button
              variant="outline"
              size="icon"
              aria-label={viewMode === "week" ? "Next week" : "Next day"}
              onClick={() => setSelectedDateKey((k) => shiftDateKey(k, viewMode === "week" ? 7 : 1))}
            >
              <ChevronRight className="w-4 h-4" />
            </Button>
            {!isCurrentPeriod && (
              <Button variant="ghost" size="sm" onClick={() => setSelectedDateKey(todayKey)}>
                {viewMode === "week" ? "Jump to this week" : "Jump to today"}
              </Button>
            )}
          </div>
          {canTodo && (
            <div className="flex items-center gap-2 flex-wrap">
            <span className="hidden md:inline text-xs text-slate-500">Hold a job to copy it to someone else</span>
            <Button size="sm" className="gap-1.5" onClick={() => openExisting(null)} disabled={!viewerId}>
              <CalendarPlus className="w-4 h-4" />
              Schedule
            </Button>
            <Button
              variant={todoOpen ? "secondary" : "outline"}
              size="sm"
              className="gap-1.5"
              aria-expanded={todoOpen}
              onClick={() => setTodoOpen((o) => !o)}
            >
              <ListTodo className="w-4 h-4" />
              {todoOpen ? "Hide to-do list" : "To-do list"}
              {todoList.length > 0 && <span className="rounded-full bg-indigo-600 px-1.5 text-[10px] font-bold text-white">{todoList.length}</span>}
            </Button>
            </div>
          )}

        </div>

        {resize ? (
          <div
            role="status"
            aria-live="polite"
            className={cn(
              "sticky top-0 z-20 mb-3 flex items-center justify-between gap-3 rounded-lg border px-3 py-2 text-sm",
              resizePlan && !resizePlan.ok ? "border-red-300 bg-red-50 text-red-900" : "border-blue-300 bg-blue-50 text-blue-900"
            )}
          >
            <p className="flex items-center gap-2 min-w-0">
              <CalendarRange className="w-4 h-4 flex-shrink-0" />
              <span className="min-w-0">
                <span className="font-semibold">#{resize.job.job_number}</span>
                {" "}{resize.booking.staff_id ? nameOf(resize.booking.staff_id) : "Unassigned"}:{" "}
                {resizePlan?.ok ? (
                  <>
                    <span className="font-semibold">{formatDateKeyRange(resizePlan.startKey, resizePlan.endKey)}</span>
                    {preview && ` · ${preview.previewDays.length} day${preview.previewDays.length === 1 ? "" : "s"}`}
                  </>
                ) : (
                  resizePlan?.error
                )}
                <span className="text-blue-700/80">
                  {resize.phase === "dragging" && " — let go to save, Esc to cancel"}
                  {resize.phase === "confirm" && " — check the clash"}
                  {resize.phase === "saving" && " — saving…"}
                </span>
              </span>
            </p>
          </div>
        ) : mode.kind === "copy" ? (
          <div
            role="status"
            className="sticky top-0 z-20 mb-3 flex items-center justify-between gap-3 rounded-lg border border-blue-300 bg-blue-50 px-3 py-2 text-sm text-blue-900"
          >
            <p className="flex items-center gap-2 min-w-0">
              <Copy className="w-4 h-4 flex-shrink-0" />
              <span className="min-w-0">
                Click a technician&apos;s day to paste a copy of <span className="font-semibold">#{mode.jobNumber}</span> — Esc to finish
              </span>
            </p>
            <Button size="sm" className="h-7 flex-shrink-0" onClick={() => dispatchMode({ type: "clear" })}>
              Done
            </Button>
          </div>
        ) : mode.kind === "schedule" ? (
          <div
            role="status"
            className="sticky top-0 z-20 mb-3 flex items-center justify-between gap-3 rounded-lg border border-blue-300 bg-blue-50 px-3 py-2 text-sm text-blue-900"
          >
            <p className="flex items-center gap-2 min-w-0">
              <CalendarPlus className="w-4 h-4 flex-shrink-0" />
              <span className="min-w-0">
                Click a technician&apos;s day to schedule <span className="font-semibold">#{mode.job.job_number}</span>
                <span className="hidden sm:inline"> — {mode.job.title}</span> — Esc to cancel
              </span>
            </p>
            <span className="flex items-center gap-1 flex-shrink-0">
              <Button
                size="sm"
                variant="ghost"
                className="h-7"
                onClick={() => {
                  const job = mode.job;
                  dispatchMode({ type: "clear" });
                  openScheduleDialog(job, null);
                }}
              >
                Open its schedule
              </Button>
              <Button size="sm" variant="ghost" className="h-7 gap-1" onClick={() => dispatchMode({ type: "clear" })}>
                <X className="w-3.5 h-3.5" />
                Cancel
              </Button>
            </span>
          </div>
        ) : cutJob ? (
          <div
            role="status"
            className="sticky top-0 z-20 mb-3 flex items-center justify-between gap-3 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900"
          >
            <p className="flex items-center gap-2 min-w-0">
              <Scissors className="w-4 h-4 flex-shrink-0" />
              <span className="truncate">
                Moving <span className="font-semibold">#{cutJob.job_number}</span> — click a technician&apos;s day to place it
                {canTodo && todoOpen ? ", or the to-do list to take it off the board" : ""}, Esc to cancel
              </span>
            </p>
            <Button size="sm" variant="ghost" className="h-7 gap-1 flex-shrink-0" onClick={() => setCut(null)}>
              <X className="w-3.5 h-3.5" />
              Cancel
            </Button>
          </div>
        ) : placing ? (
          <div
            role="status"
            className="sticky top-0 z-20 mb-3 flex items-center justify-between gap-3 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900"
          >
            <p className="flex items-center gap-2 min-w-0">
              <ListTodo className="w-4 h-4 flex-shrink-0" />
              <span className="truncate">
                Placing <span className="font-semibold">#{placing.job_number}</span> from the to-do list — tap a technician&apos;s day to book it, Esc to cancel
              </span>
            </p>
            <Button size="sm" variant="ghost" className="h-7 gap-1 flex-shrink-0" onClick={() => setPlacing(null)}>
              <X className="w-3.5 h-3.5" />
              Cancel
            </Button>
          </div>
        ) : (
          <p className="text-xs text-slate-400 mb-3">
            {viewMode === "day"
              ? "Each card is one technician's booking. Press and hold it and drag it onto a technician — or double-click it, then click the technician — to move that booking to them. Hold Shift as you drop to book them on the same time as well."
              : "Each card is one technician's booking. Press and hold it and drag it onto another technician and/or day — or double-click it, then click the cell — to move that booking. Hold Shift as you drop on a technician to book them as well. Drag a booking's left or right edge to change its first or last day."}
            {canTodo && " Press and hold (or right-click) a booking to copy it to someone else. Drag a to-do job onto a day to book it; drag a booking onto the to-do list to take it off."}
          </p>
        )}

        <DndContext sensors={sensors} collisionDetection={boardCollision} onDragStart={handleDragStart} onDragMove={handleDragMove} onDragEnd={handleDragEnd} onDragCancel={() => { setActiveEntry(null); setActiveTodo(null); }}>
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start">
        <div className="min-w-0 flex-1">
        {viewMode === "day" ? (
          <>
            {/* The phone's Day view (25 Nov 2026): technicians down the side,
                the hours across the top, each booking a block spanning its
                hours, overlaps in lanes (lib/schedule-grid.ts layoutDayRow).
                Names stay pinned on the left and the hours on top while the
                timeline scrolls. A drop on a technician's row gives them the
                booking at the same time, as before. */}
            <div
              className="overflow-auto pb-2 max-h-[calc(100vh_-_13rem)] rounded-xl border border-slate-200 bg-white"
              data-board-scroller
              data-day-timeline
            >
              <div style={{ width: NAME_COLUMN_WIDTH + dayTimelineWidth }}>
                <div className="sticky top-0 z-20 flex border-b border-slate-200 bg-white">
                  <div
                    className="sticky left-0 z-30 flex-shrink-0 border-r border-slate-200 bg-white px-2 py-2 text-[11px] font-bold uppercase text-slate-500"
                    style={{ width: NAME_COLUMN_WIDTH }}
                  >
                    Technician
                  </div>
                  {Array.from({ length: dayRange.endHour - dayRange.startHour }, (_, i) => (
                    <div
                      key={i}
                      className="flex-shrink-0 border-r border-slate-200 px-1.5 py-2 text-xs font-bold text-slate-700"
                      style={{ width: WEB_HOUR_WIDTH }}
                    >
                      {`${dayRange.startHour + i}:00`}
                    </div>
                  ))}
                </div>

                {[{ staffId: null as string | null, name: "Unassigned" }, ...sortedStaff.map((m) => ({ staffId: m.id as string | null, name: m.full_name }))].map((row) => {
                  const entries = (row.staffId ? board.byStaff.get(row.staffId)?.get(selectedDateKey) : board.unassigned.get(selectedDateKey)) ?? [];
                  const rowLeave = row.staffId ? leaveOn(row.staffId, selectedDateKey) : [];
                  const { items, height } = layoutDayRow(entries, rowLeave, dayRange, { hourWidth: WEB_HOUR_WIDTH, laneHeight: WEB_LANE_HEIGHT });
                  const source: BoardCell = { staffId: row.staffId, dateKey: selectedDateKey };
                  const hours = row.staffId ? periodHours.get(row.staffId) ?? 0 : 0;
                  const gap = row.staffId ? gapFor(row.staffId, selectedDateKey) : undefined;
                  const showGap = gap?.kind === "free" && gap.hours > 0;
                  const showAdd = canTodo && !onPick && selectedDateKey >= todayKey;
                  return (
                    <div key={row.staffId ?? "unassigned"} className="flex">
                      <div
                        className="group/cell sticky left-0 z-10 flex flex-shrink-0 flex-col justify-center border-b border-r border-slate-200 bg-white px-2 py-1 shadow-[4px_0_6px_-4px_rgba(0,0,0,0.12)]"
                        style={{ width: NAME_COLUMN_WIDTH, height }}
                      >
                        <p className={cn("truncate text-[13px] font-bold", row.staffId ? "text-slate-900" : "text-orange-700")}>{row.name}</p>
                        <p className="truncate text-[11px] text-slate-500">
                          {row.staffId
                            ? hours > 0
                              ? formatHours(hours)
                              : rowLeave.length > 0
                                ? leaveLabel(rowLeave[0].leave.leave_type)
                                : "Free"
                            : entries.length > 0
                              ? `${entries.length} booking${entries.length === 1 ? "" : "s"} need a tech`
                              : "Move a booking here to unassign it"}
                        </p>
                        {(showGap || showAdd) && (
                          <div className="mt-0.5 flex items-center gap-1">
                            {showGap && gap ? <GapButton hours={gap.hours} onClick={filterToGap} compact /> : null}
                            {showAdd ? <AddExistingJobButton onClick={() => openExisting({ staffId: row.staffId, dateKey: selectedDateKey })} compact /> : null}
                          </div>
                        )}
                      </div>
                      <DroppableTimelineRow id={columnId(row.staffId)} width={dayTimelineWidth} height={height} onPick={onPick}>
                        {selectedDateKey === liveTodayKey && <NowLine dayKey={selectedDateKey} startHour={dayRange.startHour} width={dayTimelineWidth} />}
                        {items.map((it) =>
                          it.kind === "leave" ? (
                            <LeaveTile key={it.id} day={it.day} compact position={{ left: it.left, top: it.top, width: it.width }} onOpen={setOpenLeave} />
                          ) : (
                            <DraggableBlock
                              key={it.id}
                              entry={it.entry}
                              source={source}
                              tag={tagFor(it.entry)}
                              {...cardWiring}
                              reassign={reassignOn(it.entry)}
                              closed={closedOn(it.entry)}
                              over={overOn(it.entry)}
                              view="day"
                              position={{ left: it.left, top: it.top, width: it.width }}
                            />
                          ),
                        )}
                      </DroppableTimelineRow>
                    </div>
                  );
                })}
              </div>
              {sortedStaff.length === 0 && <p className="text-slate-400 text-sm p-4">No active staff found.</p>}
            </div>
          </>
        ) : (
          <>
            {/* Names stay pinned on the left as you scroll across the days, and
                the days stay pinned on top as you scroll down the team — the
                way the phone's schedule grid works (Justin, 15 Nov 2026). The
                scroller scrolls both ways inside a capped height so both edges
                have something to stick to; the grid itself must NOT clip
                (overflow-hidden), or sticky cells stop sticking. */}
            <div className="overflow-auto pb-2 max-h-[calc(100vh_-_13rem)] rounded-xl border border-slate-200" data-board-scroller>
              <div
                className="grid min-w-[960px] bg-slate-200 gap-px"
                style={{ gridTemplateColumns: "160px repeat(7, minmax(120px, 1fr))" }}
              >
                <div className="bg-white p-2 sticky top-0 left-0 z-30" />
                {weekKeys.map((key) => (
                  <div key={key} className={cn("bg-white p-2 text-center sticky top-0 z-20 shadow-[0_1px_0_0_rgb(226_232_240)]", key === todayKey && "bg-blue-50")}>
                    <p className={cn("text-xs font-bold", key === todayKey ? "text-blue-600" : "text-slate-700")}>
                      {formatDate(anchorForDateKey(key), { weekday: "short", day: "numeric", month: "short" })}
                    </p>
                  </div>
                ))}

                <div className={PINNED_NAME}>
                  <span className="text-[13px] font-bold text-orange-700 truncate">Unassigned</span>
                </div>
                {weekKeys.map((key) => (
                  <DroppableWeekCell
                  key={key}
                  id={weekCellId(null, key)}
                  isToday={key === todayKey}
                  onPick={onPick}
                  onAddJob={canTodo && key >= todayKey ? () => openExisting({ staffId: null, dateKey: key }) : undefined}
                >
                    {(board.unassigned.get(key) ?? []).map((entry) => (
                      <DraggableBlock
                        key={entry.booking.id}
                        entry={entry}
                        source={{ staffId: null, dateKey: key }}
                        tag={tagFor(entry)}
                        {...cardWiring}
                        reassign={reassignOn(entry)}
                        closed={closedOn(entry)}
                        over={overOn(entry)}
                        view="week"
                        handles={handlesFor(entry)}
                        onResizeStart={startResize}
                        resizeState={resizeStateFor(entry)}
                      />
                    ))}
                  </DroppableWeekCell>
                ))}

                {sortedStaff.map((member) => {
                  const memberDays = board.byStaff.get(member.id);
                  const memberHours = board.hours.get(member.id);
                  const weekHours = periodHours.get(member.id) ?? 0;
                  return (
                    <Fragment key={member.id}>
                      <div className={PINNED_NAME}>
                        <div className="min-w-0">
                          <p className="text-[13px] font-bold text-slate-900 truncate">{member.full_name}</p>
                          <p className="text-[11px] text-slate-500">{weekHours > 0 ? `${formatHours(weekHours)} this week` : "Free"}</p>
                        </div>
                      </div>
                      {weekKeys.map((key) => (
                        <DroppableWeekCell
                          key={key}
                          id={weekCellId(member.id, key)}
                          isToday={key === todayKey}
                          hours={memberHours?.get(key) ?? 0}
                          gap={gapFor(member.id, key)}
                          onGapClick={filterToGap}
                          onPick={onPick}
                          onAddJob={canTodo && key >= todayKey ? () => openExisting({ staffId: member.id, dateKey: key }) : undefined}
                        >
                          {leaveOn(member.id, key).map((day) => (
                            <LeaveTile key={`leave-${day.leave.start_date}-${day.startIso}`} day={day} compact onOpen={setOpenLeave} />
                          ))}
                          {(memberDays?.get(key) ?? []).map((entry) => (
                            <DraggableBlock
                              key={entry.booking.id}
                              entry={entry}
                              source={{ staffId: member.id, dateKey: key }}
                              tag={tagFor(entry)}
                              {...cardWiring}
                              reassign={reassignOn(entry)}
                              closed={closedOn(entry)}
                              over={overOn(entry)}
                              view="week"
                        handles={handlesFor(entry)}
                              onResizeStart={startResize}
                              resizeState={resizeStateFor(entry)}
                            />
                          ))}
                        </DroppableWeekCell>
                      ))}
                    </Fragment>
                  );
                })}
              </div>

              {sortedStaff.length === 0 && (
                <p className="text-slate-400 text-sm py-4">No active staff found.</p>
              )}
            </div>
          </>
        )}
        </div>

        {canTodo && todoOpen && (
          <div className="w-full max-h-[70vh] lg:w-72 lg:flex-shrink-0 order-first lg:order-last lg:sticky lg:top-2 lg:max-h-[calc(100vh_-_10rem)] flex">
            <TodoBoardPanel
              jobs={todoList}
              error={todoError}
              gapInput={gapInput}
              onGapInput={setGapInput}
              placingJobId={placing?.id ?? null}
              onPlace={(job) => {
                setPlacing(job);
                // On a phone the panel sits above the board: fold it away so
                // the day to tap is on screen (the banner says what's picked).
                if (job && !window.matchMedia?.("(min-width: 1024px)").matches) setTodoOpen(false);
              }}
              onRemove={(job) => void removeFromTodo(job)}
              onAdded={(job) => {
                setTodoList((prev) => [...prev.filter((j) => j.id !== job.id), job]);
                router.refresh();
              }}
              bookingDragActive={!!activeEntry}
              cutActive={mode.kind === "cut"}
              onCutDrop={() => {
                if (mode.kind === "cut") void dragOut(mode.pickup);
              }}
              onClose={() => setTodoOpen(false)}
            />
          </div>
        )}
        </div>

        <DragOverlay>
          {activeTodo ? (
            <TodoDragCard job={activeTodo} />
          ) : activeEntry && !menu ? (
            <div className="w-48 rounded-lg bg-white shadow-lg rotate-1" style={{ height: BLOCK_HEIGHT }}>
              <div className="h-full overflow-hidden rounded-lg px-1.5 py-[3px]" style={blockStyle(activeEntry.job, overOn(activeEntry), reassignOn(activeEntry))}>
                <BlockBody entry={activeEntry} tag={tagFor(activeEntry)} reassign={reassignOn(activeEntry)} over={overOn(activeEntry)} view={viewMode} />
              </div>
            </div>
          ) : null}
        </DragOverlay>
        </DndContext>
      </div>
      )}

      <TabsContent value="list" className="mt-4 space-y-6">
        <Card>
          <CardHeader><CardTitle className="text-base">Today</CardTitle></CardHeader>
          <CardContent className="p-0">
            {todayJobsLive.length === 0 ? (
              <p className="text-slate-400 text-sm text-center py-8">No jobs scheduled for today</p>
            ) : (
              <div className="divide-y">
                {todayJobsLive.map((job) => {
                  const days = jobDays.get(job.id) ?? [];
                  const index = days.findIndex((d) => d.dateKey === liveTodayKey);
                  const today = days[index];
                  const dayOf = today ? dayOfLabel({ dayNumber: index + 1, dayCount: days.length }) : null;
                  const names = bookedNames(bookingsByJob.get(job.id) ?? [], staffById);
                  return (
                    <Link prefetch={false} key={job.id} href={`/dashboard/jobs/${job.id}`} className="flex items-center gap-4 px-6 py-4 hover:bg-slate-50 transition-colors group">
                      <div className="text-center w-16 flex-shrink-0">
                        <p className="text-xs font-bold text-blue-600">{formatTime(today?.startIso ?? job.scheduled_start!)}</p>
                        {today && today.endIso !== today.startIso && <p className="text-xs text-slate-400">{formatTime(today.endIso)}</p>}
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="font-medium text-sm group-hover:text-blue-600 transition-colors truncate">#{job.job_number} — {job.title}</p>
                        <p className="text-xs text-slate-500 truncate">
                          {[dayOf, job.customers?.name, names].filter(Boolean).join(" · ")}
                        </p>
                      </div>
                      <WazeButton site={job.sites} />
                      <span className={`text-xs px-2 py-0.5 rounded-full font-medium capitalize flex-shrink-0 ${jobStatusColors[job.status] ?? ""}`}>
                        {job.status.replace("_", " ")}
                      </span>
                    </Link>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>

        {upcomingJobsLive.length > 0 && (
          <Card>
            <CardHeader><CardTitle className="text-base">Upcoming</CardTitle></CardHeader>
            <CardContent className="p-0">
              <div className="divide-y">
                {upcomingJobsLive.map((job) => {
                  const days = jobDays.get(job.id) ?? [];
                  const multiDay = days.length > 1;
                  const names = bookedNames(bookingsByJob.get(job.id) ?? [], staffById);
                  const first = days[0];
                  return (
                    <Link prefetch={false} key={job.id} href={`/dashboard/jobs/${job.id}`} className="flex items-center gap-4 px-6 py-4 hover:bg-slate-50 transition-colors group">
                      <div className="text-center w-20 flex-shrink-0">
                        <p className="text-xs font-bold text-slate-700">{formatDate(first.startIso)}</p>
                        <p className="text-xs text-slate-400">{formatTime(first.startIso)}</p>
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="font-medium text-sm group-hover:text-blue-600 transition-colors truncate">#{job.job_number} — {job.title}</p>
                        <p className="text-xs text-slate-500 truncate">
                          {[
                            multiDay ? `${days.length} days, until ${formatDate(days[days.length - 1].startIso)}` : null,
                            job.customers?.name,
                            names,
                          ]
                            .filter(Boolean)
                            .join(" · ")}
                        </p>
                      </div>
                      <WazeButton site={job.sites} />
                    </Link>
                  );
                })}
              </div>
            </CardContent>
          </Card>
        )}
      </TabsContent>

      <TabsContent value="todo" className="mt-4">
        <TodoListPanel jobs={todoList} error={todoError} />
      </TabsContent>

      {/* A resize released onto days the technician is already booked:
          their call, but never a silent overlap. Closing it any way other
          than "Book anyway" snaps the booking back. */}
      <Dialog
        open={resize?.phase === "confirm"}
        onOpenChange={(open) => {
          if (!open && resizeRef.current?.phase === "confirm") setResize(null);
        }}
      >
        <DialogContent>
          {resize?.phase === "confirm" && (
            <>
              <DialogHeader>
                <DialogTitle>
                  {resize.conflicts.length > 0
                    ? `${nameOf(resize.booking.staff_id)} is already booked then`
                    : `${nameOf(resize.booking.staff_id)} isn't available then`}
                </DialogTitle>
                <DialogDescription>
                  Stretching #{resize.job.job_number}
                  {resizePlan?.ok && <> to {formatDateKeyRange(resizePlan.startKey, resizePlan.endKey)}</>}
                  {resize.conflicts.length > 0 ? " overlaps:" : ":"}
                </DialogDescription>
              </DialogHeader>
              {resize.leaveConflicts.length > 0 && (
                <p className="rounded-md border border-rose-200 bg-rose-50 px-2.5 py-1.5 text-sm text-rose-900">
                  {describeLeaveConflicts(nameOf(resize.booking.staff_id), resize.leaveConflicts)}
                </p>
              )}
              <ul className="space-y-1.5 text-sm max-h-60 overflow-y-auto">
                {resize.conflicts.map((c) => (
                  <li key={c.booking.id} className="rounded-md border border-amber-200 bg-amber-50 px-2.5 py-1.5">
                    <p className="font-medium text-slate-900 truncate">
                      #{c.job.job_number} — {c.job.title}
                    </p>
                    <p className="text-xs text-slate-600">
                      {c.days
                        .map((d) => `${formatDate(anchorForDateKey(d.dateKey), { weekday: "short", day: "numeric", month: "short" })} ${formatTime(d.startIso)}–${formatTime(d.endIso)}`)
                        .join(" · ")}
                    </p>
                  </li>
                ))}
              </ul>
              <DialogFooter>
                <Button variant="outline" onClick={() => setResize(null)}>Cancel</Button>
                <Button onClick={() => void saveResize(resize)}>Book anyway</Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
      <BookingCostCentreDialog request={costCentreAsk} onDone={closeCostCentre} />
      {canTodo && (
        <ScheduleExistingJobDialog
          open={existingOpen}
          prefill={existingFor}
          staffName={existingFor?.staffId ? nameOf(existingFor.staffId) : existingFor ? "Unassigned" : null}
          onOpenChange={setExistingOpen}
          onPick={viewerId ? pickedFromSearch : undefined}
        />
      )}
      {canTodo && viewerId && (
        <BoardScheduleDialog
          request={scheduleRequest}
          staff={staff.filter((s) => !s.full_name.endsWith("(inactive)"))}
          currentUserId={viewerId}
          onClose={() => setScheduleRequest(null)}
        />
      )}
      {hoverCard.target && (() => {
        const entry = hoverCard.target.item;
        const over = overOn(entry);
        const leaveHits = reassign.get(entry.booking.id)?.filter((c) => c.dateKey === entry.day.dateKey) ?? [];
        return (
          <BookingHoverCard
            id={hoverCardId}
            anchor={hoverCard.target.anchor}
            details={hoverCardDetails(entry, bookingsByJob.get(entry.job.id) ?? [], shownDays, nameOf)}
            href={`/dashboard/jobs/${entry.job.id}`}
            navigateUrl={wazeUrl(entry.job.sites)}
            completed={isClosedJob(entry.job)}
            overText={over?.text ?? null}
            leaveText={leaveHits.length > 0 ? `${NEEDS_REASSIGNING} — ${leaveDayLabel(leaveHits[0].leaveDay)}` : null}
            onPointerEnter={hoverCard.keep}
            onPointerLeave={hoverCard.leave}
          />
        );
      })()}
      {menu && menuBooking && menuJob && (
        <BookingMenu
          at={menu.at}
          title={`#${menuJob.job_number} — ${menuBooking.staff_id ? nameOf(menuBooking.staff_id) : "Unassigned"}`}
          items={bookingMenuItems({
            closed: isClosedJob(menuJob) ? menuJob.status : null,
            unsaved: menuBooking.id.startsWith("pending:") || menuBooking.id.startsWith("legacy:"),
            readOnly: bookingsReadOnly,
            canTodo,
          })}
          onAction={onMenuAction}
          onClose={closeMenu}
        />
      )}
      {/* Booking someone onto their leave: asked, never silent. */}
      <Dialog open={!!confirm} onOpenChange={(open) => { if (!open) closeConfirm(false); }}>
        <DialogContent>
          {confirm && (
            <>
              <DialogHeader>
                <DialogTitle>{confirm.title}</DialogTitle>
                <DialogDescription>{confirm.lines[0]}</DialogDescription>
              </DialogHeader>
              {confirm.lines.slice(1).map((line) => (
                <p key={line} className="rounded-md border border-rose-200 bg-rose-50 px-2.5 py-1.5 text-sm text-rose-900">{line}</p>
              ))}
              <DialogFooter>
                <Button variant="outline" onClick={() => closeConfirm(false)}>Cancel</Button>
                <Button onClick={() => closeConfirm(true)}>{confirm.action}</Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
      {/* A leave tile's details. Read-only: leave is entered (or imported from
          Xero) in Staff → Cost & Leave, which only an admin can open. */}
      <Dialog open={!!openLeave} onOpenChange={(open) => { if (!open) setOpenLeave(null); }}>
        <DialogContent>
          {openLeave && (
            <>
              <DialogHeader>
                <DialogTitle>{nameOf(openLeave.leave.staff_id)} — {leaveLabel(openLeave.leave.leave_type)}</DialogTitle>
                <DialogDescription>{leaveRangeLabel(openLeave.leave)}</DialogDescription>
              </DialogHeader>
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
                <dt className="text-slate-500">This day</dt>
                <dd className="font-medium">{leaveDayLabel(openLeave)}</dd>
                {openLeave.leave.hours !== null && (
                  <>
                    <dt className="text-slate-500">Hours in total</dt>
                    <dd>{formatHours(openLeave.leave.hours)}</dd>
                  </>
                )}
              </dl>
              {(() => {
                const affected = bookings.filter((b) => reassign.get(b.id)?.some((c) => c.leaveDay.leave === openLeave.leave));
                return affected.length > 0 ? (
                  <p className="rounded-md border border-rose-200 bg-rose-50 px-2.5 py-1.5 text-sm text-rose-900">
                    {affected.length === 1 ? "1 booking on these days needs" : `${affected.length} bookings on these days need`} reassigning:{" "}
                    {affected.map((b) => `#${jobsById.get(b.job_id)?.job_number ?? "?"}`).join(", ")}
                  </p>
                ) : null;
              })()}
              <p className="text-xs text-slate-500">Read only. Leave is entered in Staff → Cost &amp; Leave, or imported from Xero Payroll.</p>
              <DialogFooter>
                <Button variant="outline" onClick={() => setOpenLeave(null)}>Close</Button>
                {viewerRole === "admin" && (
                  <Link href={`/dashboard/staff?leave=${openLeave.leave.staff_id}`} prefetch={false}>
                    <Button>Open leave record</Button>
                  </Link>
                )}
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </Tabs>
  );
}
