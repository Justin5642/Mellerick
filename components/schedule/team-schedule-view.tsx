"use client";

import Link from "next/link";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  closestCenter,
  pointerWithin,
  type CollisionDetection,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
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
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
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
import { Navigation, LayoutList, ListTodo, ChevronLeft, ChevronRight, GripVertical, CalendarDays, CalendarRange, Scissors, StickyNote, X, CalendarPlus, Plus } from "lucide-react";
import {
  formatTime,
  formatDate,
  dateKeyInBusinessTZ,
  shiftDateKey,
  anchorForDateKey,
  weekDateKeys,
} from "@/lib/date";
import { jobStatusColors } from "@/lib/badge-colors";
import { cn } from "@/lib/utils";

type StaffMember = {
  id: string;
  full_name: string;
  role: string;
};

/** A booking picked up — by drag or by double-click — and the cell it came from. */
type Pickup = { bookingId: string; source: BoardCell };

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

function initials(name: string) {
  return name
    .split(" ")
    .map((n) => n[0])
    .join("")
    .toUpperCase()
    .slice(0, 2);
}

// Small deterministic accent so each column is visually distinct without
// needing a per-staff color field in the database.
const accents = [
  "bg-blue-500", "bg-emerald-500", "bg-amber-500", "bg-violet-500",
  "bg-rose-500", "bg-cyan-500", "bg-orange-500", "bg-teal-500",
];
function accentFor(id: string) {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  return accents[hash % accents.length];
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
 * The hours on the card's own day. For a multi-day booking that is that day's
 * block (7:00–15:30), not the first-day start and last-day end the row holds.
 */
function EntryTime({ entry }: { entry: BoardEntry }) {
  const { startIso, endIso } = entry.day;
  return (
    <>
      {formatTime(startIso)}
      {endIso !== startIso && (
        <span className="text-slate-400 font-medium">
          {" "}–{" "}
          {formatTime(endIso)}
        </span>
      )}
    </>
  );
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
function LeaveTile({ day, compact, onOpen }: { day: LeaveDay; compact?: boolean; onOpen: (day: LeaveDay) => void }) {
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
      className={cn("block w-full text-left rounded-md border border-l-4 font-semibold cursor-pointer", compact ? "px-2 py-1" : "px-3 py-2")}
      style={{
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

function NeedsReassigningBadge() {
  return (
    <span className="inline-block rounded bg-rose-600 px-1 text-[10px] font-bold leading-4 text-white" title="This technician is on leave this day">
      {NEEDS_REASSIGNING}
    </span>
  );
}

/** Props every placed card shares: where it sits, who it belongs to, and the cut-mode wiring. */
type PlacedProps = {
  entry: BoardEntry;
  source: BoardCell;
  tag: TileTag;
  cut: Pickup | null;
  onCut: (pickup: Pickup) => void;
  /** Booked on a day this technician is on leave (0112). */
  reassign: boolean;
};

function isCutHere(cut: Pickup | null, bookingId: string, source: BoardCell) {
  return !!cut && cut.bookingId === bookingId && cut.source.staffId === source.staffId && cut.source.dateKey === source.dateKey;
}

function JobCardBody({ entry, tag, reassign }: { entry: BoardEntry; tag: TileTag; reassign?: boolean }) {
  const { job, booking } = entry;
  const dayOf = dayOfLabel(entry);
  return (
    <>
      {reassign && <div className="mb-1"><NeedsReassigningBadge /></div>}
      <div className="flex items-center justify-between gap-2 pr-4">
        <p className="text-xs font-bold text-blue-600 min-w-0 truncate">
          <EntryTime entry={entry} />
        </p>
        <span className="flex items-center gap-1 flex-shrink-0">
          <TileStaffTag tag={tag} />
          <span
            className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium capitalize flex-shrink-0 ${jobStatusColors[job.status] ?? ""}`}
          >
            {job.status.replace("_", " ")}
          </span>
        </span>
      </div>
      <p className="text-sm font-medium mt-1 group-hover:text-blue-600 transition-colors truncate">
        #{job.job_number} — {job.title}
      </p>
      {booking.cost_center_name && (
        <p className="text-xs font-medium text-cyan-700 truncate">{booking.cost_center_name}</p>
      )}
      <BookingNoteLine note={booking.note} className="text-xs" />
      <p className="text-xs text-slate-500 truncate">
        {dayOf && <span className="font-medium text-violet-600">{dayOf}</span>}
        {dayOf && job.customers?.name && " · "}
        {job.customers?.name}
      </p>
      <div className="mt-1"><WazeButton site={job.sites} /></div>
    </>
  );
}

const JOB_CARD_CLASS =
  "@container block px-3 py-2.5 rounded-lg border border-slate-200 hover:border-blue-300 hover:bg-blue-50/50 transition-colors group";

// Wraps a job card in a draggable node for the Day board. A long-press (past
// the sensor's activation delay) starts a drag; a quick tap opens the job; a
// double-click cuts it for pasting (BoardJobLink).
//
// The draggable id is per PLACEMENT, not per booking: a multi-day booking
// sits in several day cells at once and dnd-kit needs each node's id to be
// unique.
function DraggableJobCard({ entry, source, tag, cut, onCut, reassign }: PlacedProps) {
  const { job, booking } = entry;
  const { setNodeRef, listeners, isDragging } = useDraggable({
    id: `${booking.id}@${weekCellId(source.staffId, source.dateKey)}`,
    data: { bookingId: booking.id, source, entry },
  });
  const isCut = isCutHere(cut, booking.id, source);
  return (
    <div
      ref={setNodeRef}
      {...listeners}
      onContextMenu={(e) => e.preventDefault()}
      style={{
        touchAction: "none",
        WebkitTouchCallout: "none",
        WebkitUserSelect: "none",
      }}
      className={cn(
        "relative cursor-grab active:cursor-grabbing select-none rounded-lg",
        isDragging && "opacity-30",
        isCut && "ring-2 ring-amber-400 bg-amber-50/60",
        reassign && !isCut && "ring-2 ring-rose-500"
      )}
    >
      <GripVertical className="w-3.5 h-3.5 text-slate-300 absolute top-2 right-2 pointer-events-none" />
      <BoardJobLink
        href={`/dashboard/jobs/${job.id}`}
        className={JOB_CARD_CLASS}
        cutActive={!!cut}
        onCut={() => onCut({ bookingId: booking.id, source })}
      >
        <JobCardBody entry={entry} tag={tag} reassign={reassign} />
      </BoardJobLink>
    </div>
  );
}

function DroppableColumn({
  id,
  className,
  onPick,
  children,
}: {
  id: string;
  className?: string;
  /** Set while a job is cut: a click anywhere in the column pastes it here. */
  onPick?: (id: string) => void;
  children: React.ReactNode;
}) {
  const { setNodeRef, isOver } = useDroppable({ id });
  return (
    <div
      ref={setNodeRef}
      onClick={onPick ? () => onPick(id) : undefined}
      className={cn(
        className,
        isOver && "ring-2 ring-blue-400 ring-offset-2",
        onPick && "cursor-copy hover:ring-2 hover:ring-amber-400 hover:ring-offset-2"
      )}
    >
      {children}
    </div>
  );
}

/** The booking's scheduling note (0109), one truncated line; the whole note on hover. */
function BookingNoteLine({ note, className }: { note?: string | null; className: string }) {
  if (!note) return null;
  return (
    <p className={cn(className, "text-amber-700 truncate flex items-center gap-1")} title={note}>
      <StickyNote className="w-3 h-3 flex-shrink-0" aria-hidden />
      <span className="truncate">{note}</span>
    </p>
  );
}

// Compact job entry for a single day cell in the week grid — the grid is
// staff (rows) x day (columns), so each cell is narrow; this trades the
// full job card's detail for a glanceable time + job + customer stack.
function WeekJobChipBody({ entry, tag, reassign }: { entry: BoardEntry; tag: TileTag; reassign?: boolean }) {
  const { job, booking } = entry;
  const dayOf = dayOfLabel(entry);
  return (
    <>
      {reassign && <NeedsReassigningBadge />}
      <div className="flex items-start justify-between gap-1">
        <p className="text-[10px] font-bold text-blue-600 truncate min-w-0">
          {formatTime(entry.day.startIso)}
          {entry.day.endIso !== entry.day.startIso && `–${formatTime(entry.day.endIso)}`}
        </p>
        <TileStaffTag tag={tag} />
      </div>
      <p className="text-[11px] font-medium text-slate-700 truncate">
        #{job.job_number} {job.title}
      </p>
      {booking.cost_center_name && <p className="text-[10px] font-medium text-cyan-700 truncate">{booking.cost_center_name}</p>}
      <BookingNoteLine note={booking.note} className="text-[10px]" />
      {dayOf && <p className="text-[10px] font-medium text-violet-600 truncate">{dayOf}</p>}
      {job.customers?.name && <p className="text-[10px] text-slate-400 truncate">{job.customers.name}</p>}
    </>
  );
}

// px-2.5 leaves room at each side for the resize handles.
const WEEK_CHIP_CLASS =
  "@container block px-2.5 py-1 rounded-md border border-slate-200 hover:border-blue-300 hover:bg-blue-50/50 transition-colors";

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
        edge === "start" ? "left-0 rounded-l-md" : "right-0 rounded-r-md"
      )}
    >
      <span className="h-5 w-[3px] rounded-full bg-blue-400 opacity-0 transition-opacity group-hover/chip:opacity-100 pointer-coarse:bg-slate-400 pointer-coarse:opacity-80" />
    </div>
  );
}

// Draggable wrapper for a week chip — same long-press-to-drag and
// double-click-to-cut pattern as DraggableJobCard on the day board. One per
// placement: two technicians each booked Mon–Wed on a job show six chips.
//
// Resize handles sit on the booking's OUTER edges only: the left one on its
// first day's chip, the right one on its last day's (a single-day booking
// has both). A day in the middle of a multi-day booking has none — its edges
// are not the booking's edges.
type ChipHandles = { start: boolean; end: boolean };
/** This chip's booking is being resized: a previewed day, a day the preview drops, or its save in flight. */
type ChipResizeState = "preview" | "removing" | "saving" | null;

function DraggableWeekJobChip({
  entry,
  source,
  tag,
  cut,
  onCut,
  reassign,
  handles,
  onResizeStart,
  resizeState,
}: PlacedProps & {
  handles: ChipHandles | null;
  onResizeStart: (entry: BoardEntry, edge: ResizeEdge, e: React.PointerEvent<HTMLElement>) => void;
  resizeState: ChipResizeState;
}) {
  const { job, booking } = entry;
  const { setNodeRef, listeners, isDragging } = useDraggable({
    id: `${booking.id}@${weekCellId(source.staffId, source.dateKey)}`,
    data: { bookingId: booking.id, source, entry },
  });
  const isCut = isCutHere(cut, booking.id, source);
  const start = (edge: ResizeEdge, e: React.PointerEvent<HTMLElement>) => onResizeStart(entry, edge, e);
  return (
    <div
      ref={setNodeRef}
      {...listeners}
      onContextMenu={(e) => e.preventDefault()}
      style={{
        touchAction: "none",
        WebkitTouchCallout: "none",
        WebkitUserSelect: "none",
      }}
      className={cn(
        "group/chip relative select-none rounded-md",
        isDragging && "opacity-30",
        isCut && "ring-2 ring-amber-400 bg-amber-50/60",
        reassign && !isCut && !resizeState && "ring-2 ring-rose-500",
        resizeState === "preview" && "ring-2 ring-blue-400 bg-blue-50/60",
        resizeState === "removing" && "opacity-40 outline-2 outline-dashed outline-slate-400 line-through",
        resizeState === "saving" && "ring-2 ring-blue-300 bg-blue-50/60 animate-pulse"
      )}
    >
      <BoardJobLink
        href={`/dashboard/jobs/${job.id}`}
        className={WEEK_CHIP_CLASS}
        cutActive={!!cut}
        onCut={() => onCut({ bookingId: booking.id, source })}
      >
        <WeekJobChipBody entry={entry} tag={tag} reassign={reassign} />
      </BoardJobLink>
      {/* Two fixed slots, so a handle that stays keeps its DOM node (and its pointer capture). */}
      {handles?.start ? <ResizeHandle edge="start" onStart={start} /> : null}
      {handles?.end ? <ResizeHandle edge="end" onStart={start} /> : null}
    </div>
  );
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
      onClick={onPick ? () => onPick(id) : undefined}
      className={cn(
        "group/cell bg-white p-1.5 space-y-1 min-h-[64px] transition-colors",
        isToday && "bg-blue-50/40",
        isOver && "ring-2 ring-inset ring-blue-400 bg-blue-50/70",
        onPick && "cursor-copy hover:ring-2 hover:ring-inset hover:ring-amber-400"
      )}
    >
      {((hours !== undefined && hours > 0) || (gap?.kind === "free" && gap.hours > 0) || (onAddJob && !onPick)) && (
        <div className="flex items-center justify-between gap-1 leading-none">
          {gap?.kind === "free" && gap.hours > 0 ? <GapButton hours={gap.hours} onClick={onGapClick} compact /> : <span />}
          <span className="flex items-center gap-1">
            {hours !== undefined && hours > 0 && <span className="text-[10px] font-semibold text-slate-500">{formatHours(hours)}</span>}
            {onAddJob && !onPick && <AddExistingJobButton onClick={onAddJob} compact />}
          </span>
        </div>
      )}
      {children}
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
  // A to-do job picked to place by tapping a cell (the touch path for drag-in).
  const [placing, setPlacing] = useState<TodoJob | null>(null);
  // The to-do job being dragged, for the overlay.
  const [activeTodo, setActiveTodo] = useState<TodoJob | null>(null);
  const jobsById = useMemo(() => new Map(boardJobs.map((j) => [j.id, j])), [boardJobs]);
  // The card being dragged, for the overlay.
  const [activeEntry, setActiveEntry] = useState<BoardEntry | null>(null);
  // The job double-clicked for cut & paste; the next cell clicked receives it.
  const [cut, setCut] = useState<Pickup | null>(null);
  // The booking whose edge is being dragged (Week view).
  const [resize, setResize] = useState<ResizeState | null>(null);
  const gesture = useRef<ResizeGesture | null>(null);
  const suppressClickUntil = useRef(0);

  const todayKey = useMemo(() => dateKeyInBusinessTZ(new Date()), []);
  const [selectedDateKey, setSelectedDateKey] = useState(todayKey);
  const viewMode: "day" | "week" = tab === "day" ? "day" : "week";

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { delay: 200, tolerance: 8 } })
  );

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
  const reassign = useMemo(() => bookingsNeedingReassignment(bookings, leave, todayKey), [bookings, leave, todayKey]);
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

  const cutJob = useMemo(() => {
    const booking = cut ? bookings.find((b) => b.id === cut.bookingId) : undefined;
    return booking ? jobsById.get(booking.job_id) ?? null : null;
  }, [cut, bookings, jobsById]);
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

  // Esc leaves cut mode.
  useEffect(() => {
    if (!cut) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setCut(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [cut]);

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
  async function moveBooking(bookingId: string, source: BoardCell, target: BoardCell, mode: "move" | "add" = "move") {
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

    if (mode === "add") {
      const copy = planBoardAdd(booking, source, target, bookingsByJob.get(job.id) ?? []);
      if (!copy) return; // Unassigned, or they already have exactly this booking
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

  // Paste: a click on any cell while a booking is cut.
  function placeCut(targetId: string) {
    if (!cut) return;
    const pickup = cut;
    setCut(null);
    const target = parseBoardTarget(targetId, selectedDateKey);
    if (target) void moveBooking(pickup.bookingId, pickup.source, target, shiftHeld.current ? "add" : "move");
  }

  function handleDragStart(event: DragStartEvent) {
    setCut(null);
    setPlacing(null);
    const data = event.active.data.current as { kind?: string; job?: TodoJob; entry?: BoardEntry } | undefined;
    if (data?.kind === "todo") {
      setActiveTodo(data.job ?? null);
      return;
    }
    setActiveEntry(data?.entry ?? null);
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
    setCut(null);
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

  // Esc stops placing.
  useEffect(() => {
    if (!placing) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPlacing(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [placing]);

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

  const onPick = cut ? placeCut : placing ? placeTodo : undefined;

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
    setCut(null);
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
            <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" className="gap-1.5" onClick={() => openExisting(null)}>
              <CalendarPlus className="w-4 h-4" />
              Schedule existing job
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
            {canTodo && " Drag a to-do job onto a day to book it; drag a booking onto the to-do list to take it off."}
          </p>
        )}

        <DndContext sensors={sensors} collisionDetection={boardCollision} onDragStart={handleDragStart} onDragEnd={handleDragEnd} onDragCancel={() => { setActiveEntry(null); setActiveTodo(null); }}>
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start">
        <div className="min-w-0 flex-1">
        {viewMode === "day" ? (
          <>
            <div className="flex gap-4 overflow-x-auto pb-2">
              {(() => {
                const unassigned = board.unassigned.get(selectedDateKey) ?? [];
                const source: BoardCell = { staffId: null, dateKey: selectedDateKey };
                return (
                  <DroppableColumn
                    id={columnId(null)}
                    onPick={onPick}
                    className="w-72 flex-shrink-0 rounded-xl sticky left-0 z-10 bg-slate-50 shadow-[4px_0_8px_-4px_rgba(0,0,0,0.08)]"
                  >
                    <Card className={cn("h-full", unassigned.length > 0 ? "border-amber-300" : "")}>
                      <CardHeader className="pb-3">
                        <div className="flex items-center gap-2">
                          <div
                            className={cn(
                              "w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0",
                              unassigned.length > 0 ? "bg-amber-100" : "bg-slate-100"
                            )}
                          >
                            <span className={cn("text-xs font-bold", unassigned.length > 0 ? "text-amber-700" : "text-slate-400")}>!</span>
                          </div>
                          <div className="min-w-0">
                            <CardTitle className="text-sm truncate">Unassigned</CardTitle>
                            <p className={cn("text-xs", unassigned.length > 0 ? "text-amber-600" : "text-slate-400")}>
                              {unassigned.length === 0
                                ? "Move a booking here to unassign it"
                                : `${unassigned.length} booking${unassigned.length === 1 ? "" : "s"} need a tech`}
                            </p>
                          </div>
                        </div>
                      </CardHeader>
                      <CardContent className="space-y-2">
                        {unassigned.length === 0 ? (
                          <p className="text-slate-400 text-xs text-center py-6 border border-dashed border-slate-200 rounded-lg">
                            No unassigned bookings
                          </p>
                        ) : (
                          unassigned.map((entry) => (
                            <DraggableJobCard key={entry.booking.id} entry={entry} source={source} tag={tagFor(entry)} cut={cut} onCut={setCut} reassign={reassignOn(entry)} />
                          ))
                        )}
                      </CardContent>
                    </Card>
                  </DroppableColumn>
                );
              })()}

              {sortedStaff.map((member) => {
                const memberEntries = board.byStaff.get(member.id)?.get(selectedDateKey) ?? [];
                const hours = periodHours.get(member.id) ?? 0;
                const source: BoardCell = { staffId: member.id, dateKey: selectedDateKey };
                return (
                  <DroppableColumn key={member.id} id={columnId(member.id)} onPick={onPick} className="w-72 flex-shrink-0 rounded-xl">
                    <Card className="h-full">
                      <CardHeader className="pb-3">
                        <div className="flex items-center gap-2">
                          <Avatar className="w-8 h-8 flex-shrink-0">
                            <AvatarFallback className={`text-white text-xs ${accentFor(member.id)}`}>
                              {initials(member.full_name)}
                            </AvatarFallback>
                          </Avatar>
                          <div className="min-w-0">
                            <CardTitle className="text-sm truncate">{member.full_name}</CardTitle>
                            <p className="text-xs text-slate-400">
                              {memberEntries.length === 0 ? (
                                leaveOn(member.id, selectedDateKey).length > 0 ? leaveLabel(leaveOn(member.id, selectedDateKey)[0].leave.leave_type) : "Free"
                              ) : (
                                <>
                                  <span className="font-semibold text-slate-600">{formatHours(hours)}</span>
                                  {` · ${memberEntries.length} job${memberEntries.length === 1 ? "" : "s"}`}
                                </>
                              )}
                            </p>
                            {(() => {
                              const gap = gapFor(member.id, selectedDateKey);
                              const showGap = gap?.kind === "free" && gap.hours > 0;
                              const showAdd = canTodo && !onPick && selectedDateKey >= todayKey;
                              return showGap || showAdd ? (
                                <div className="mt-1 flex items-center gap-1">
                                  {showGap && gap ? <GapButton hours={gap.hours} onClick={filterToGap} /> : null}
                                  {showAdd ? <AddExistingJobButton onClick={() => openExisting({ staffId: member.id, dateKey: selectedDateKey })} /> : null}
                                </div>
                              ) : null;
                            })()}
                          </div>
                        </div>
                      </CardHeader>
                      <CardContent className="space-y-2">
                        {leaveOn(member.id, selectedDateKey).map((day) => (
                          <LeaveTile key={`leave-${day.leave.start_date}-${day.startIso}`} day={day} onOpen={setOpenLeave} />
                        ))}
                        {memberEntries.length === 0 ? (
                          <p className="text-slate-400 text-xs text-center py-6 border border-dashed border-slate-200 rounded-lg">
                            No jobs scheduled
                          </p>
                        ) : (
                          memberEntries.map((entry) => (
                            <DraggableJobCard key={entry.booking.id} entry={entry} source={source} tag={tagFor(entry)} cut={cut} onCut={setCut} reassign={reassignOn(entry)} />
                          ))
                        )}
                      </CardContent>
                    </Card>
                  </DroppableColumn>
                );
              })}

              {sortedStaff.length === 0 && (
                <p className="text-slate-400 text-sm py-8">No active staff found.</p>
              )}
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
                    <p className="text-xs font-semibold text-slate-900">
                      {formatDate(anchorForDateKey(key), { weekday: "short" })}
                    </p>
                    <p className="text-[11px] text-slate-400">
                      {formatDate(anchorForDateKey(key), { day: "numeric", month: "short" })}
                    </p>
                  </div>
                ))}

                <div className={PINNED_NAME}>
                  <div className="w-6 h-6 rounded-full bg-amber-100 flex items-center justify-center flex-shrink-0">
                    <span className="text-[10px] font-bold text-amber-700">!</span>
                  </div>
                  <span className="text-xs font-medium text-slate-700 truncate">Unassigned</span>
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
                      <DraggableWeekJobChip
                        key={entry.booking.id}
                        entry={entry}
                        source={{ staffId: null, dateKey: key }}
                        tag={tagFor(entry)}
                        cut={cut}
                        onCut={setCut}
                        reassign={reassignOn(entry)}
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
                        <Avatar className="w-6 h-6 flex-shrink-0">
                          <AvatarFallback className={`text-white text-[10px] ${accentFor(member.id)}`}>
                            {initials(member.full_name)}
                          </AvatarFallback>
                        </Avatar>
                        <div className="min-w-0">
                          <p className="text-xs font-medium text-slate-700 truncate">{member.full_name}</p>
                          <p className="text-[10px] text-slate-400">{weekHours > 0 ? `${formatHours(weekHours)} this week` : "Free"}</p>
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
                            <DraggableWeekJobChip
                              key={entry.booking.id}
                              entry={entry}
                              source={{ staffId: member.id, dateKey: key }}
                              tag={tagFor(entry)}
                              cut={cut}
                              onCut={setCut}
                              reassign={reassignOn(entry)}
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
                setCut(null);
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
              cutActive={!!cut}
              onCutDrop={() => {
                if (cut) void dragOut(cut);
              }}
              onClose={() => setTodoOpen(false)}
            />
          </div>
        )}
        </div>

        <DragOverlay>
          {activeTodo ? (
            <TodoDragCard job={activeTodo} />
          ) : activeEntry ? (
            viewMode === "day" ? (
              <div className="w-72 shadow-lg rounded-lg rotate-1 bg-white">
                <div className={JOB_CARD_CLASS}>
                  <JobCardBody entry={activeEntry} tag={tagFor(activeEntry)} reassign={reassignOn(activeEntry)} />
                </div>
              </div>
            ) : (
              <div className="w-48 shadow-lg rounded-lg rotate-1 bg-white">
                <div className={WEEK_CHIP_CLASS}>
                  <WeekJobChipBody entry={activeEntry} tag={tagFor(activeEntry)} reassign={reassignOn(activeEntry)} />
                </div>
              </div>
            )
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
