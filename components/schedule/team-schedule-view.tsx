"use client";

import Link from "next/link";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  closestCenter,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
// Every move writes ONE booking row (lib/bookings.ts) and then pushes the job
// to Google Calendar (pushJobToCalendar — a move the calendar never hears
// about is what the poll in lib/google.ts used to "correct" by undoing it).
// The crew and the job's own window follow from the bookings in the database
// (triggers in 0079 yet), so nothing here writes
// assigned_to, job_assignments or jobs.scheduled_* any more.
import { pushJobToCalendar } from "@/lib/schedule-dispatch";
import { bookingWindow, insertBookings, updateBooking, type BookingWriteClient } from "@/lib/bookings";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { TodoListPanel, type TodoJob } from "./todo-list-panel";
import { BoardJobLink } from "./board-job-link";
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
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Navigation, LayoutList, ListTodo, ChevronLeft, ChevronRight, GripVertical, CalendarDays, CalendarRange, Scissors, X } from "lucide-react";
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

/** Props every placed card shares: where it sits, who it belongs to, and the cut-mode wiring. */
type PlacedProps = {
  entry: BoardEntry;
  source: BoardCell;
  tag: TileTag;
  cut: Pickup | null;
  onCut: (pickup: Pickup) => void;
};

function isCutHere(cut: Pickup | null, bookingId: string, source: BoardCell) {
  return !!cut && cut.bookingId === bookingId && cut.source.staffId === source.staffId && cut.source.dateKey === source.dateKey;
}

function JobCardBody({ entry, tag }: { entry: BoardEntry; tag: TileTag }) {
  const { job, booking } = entry;
  const dayOf = dayOfLabel(entry);
  return (
    <>
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
function DraggableJobCard({ entry, source, tag, cut, onCut }: PlacedProps) {
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
        isCut && "ring-2 ring-amber-400 bg-amber-50/60"
      )}
    >
      <GripVertical className="w-3.5 h-3.5 text-slate-300 absolute top-2 right-2 pointer-events-none" />
      <BoardJobLink
        href={`/dashboard/jobs/${job.id}`}
        className={JOB_CARD_CLASS}
        cutActive={!!cut}
        onCut={() => onCut({ bookingId: booking.id, source })}
      >
        <JobCardBody entry={entry} tag={tag} />
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

// Compact job entry for a single day cell in the week grid — the grid is
// staff (rows) x day (columns), so each cell is narrow; this trades the
// full job card's detail for a glanceable time + job + customer stack.
function WeekJobChipBody({ entry, tag }: { entry: BoardEntry; tag: TileTag }) {
  const { job, booking } = entry;
  const dayOf = dayOfLabel(entry);
  return (
    <>
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
        <WeekJobChipBody entry={entry} tag={tag} />
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
  onPick,
  children,
}: {
  id: string;
  isToday?: boolean;
  /** Booked hours for this technician on this day; omitted for Unassigned. */
  hours?: number;
  onPick?: (id: string) => void;
  children: React.ReactNode;
}) {
  const { setNodeRef, isOver } = useDroppable({ id });
  return (
    <div
      ref={setNodeRef}
      data-week-cell
      onClick={onPick ? () => onPick(id) : undefined}
      className={cn(
        "bg-white p-1.5 space-y-1 min-h-[64px] transition-colors",
        isToday && "bg-blue-50/40",
        isOver && "ring-2 ring-inset ring-blue-400 bg-blue-50/70",
        onPick && "cursor-copy hover:ring-2 hover:ring-inset hover:ring-amber-400"
      )}
    >
      {hours !== undefined && hours > 0 && (
        <p className="text-[10px] font-semibold text-slate-500 text-right leading-none">{formatHours(hours)}</p>
      )}
      {children}
    </div>
  );
}

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

export function TeamScheduleView({
  jobs,
  bookings: initialBookings,
  bookingsReadOnly,
  staff,
  todoJobs,
  todoError,
}: {
  jobs: BoardJob[];
  bookings: BoardBooking[];
  /** The bookings were derived from the job windows (job_bookings not in this database yet); moves are refused. */
  bookingsReadOnly: boolean;
  staff: StaffMember[];
  todoJobs: TodoJob[];
  todoError: string | null;
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
  const jobsById = useMemo(() => new Map(jobs.map((j) => [j.id, j])), [jobs]);
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
    for (const job of jobs) map.set(job.id, jobDaysFromBookings(bookingsByJob.get(job.id) ?? [], bookingDays));
    return map;
  }, [jobs, bookingsByJob, bookingDays]);

  // Read every render, as isTodayInBusinessTZ did, so a board left open past
  // midnight still re-splits today/upcoming on its next render. "Today" is
  // any job with a booking today — a multi-day booking in its second day
  // included.
  const liveTodayKey = dateKeyInBusinessTZ(new Date());
  const { todayJobsLive, upcomingJobsLive } = useMemo(() => {
    const today: BoardJob[] = [];
    const upcoming: BoardJob[] = [];
    for (const job of jobs) {
      const days = jobDays.get(job.id) ?? [];
      if (days.length === 0) continue;
      (days.some((d) => d.dateKey === liveTodayKey) ? today : upcoming).push(job);
    }
    // Upcoming in order of the job's first booked day, which can differ from
    // the page's scheduled_start order once a booking has been moved here.
    upcoming.sort((a, b) => (jobDays.get(a.id)![0].startIso < jobDays.get(b.id)![0].startIso ? -1 : 1));
    return { todayJobsLive: today, upcomingJobsLive: upcoming };
  }, [jobs, jobDays, liveTodayKey]);

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
      setBookings((prev) => prev.map((b) => (b.id === tempId ? { ...real, cost_center_name: booking.cost_center_name } : b)));
      announce(`#${job.job_number} booked for ${nameOf(target.staffId)} too`, await pushJobToCalendar(job.id));
      return;
    }

    const patch = planBoardMove(booking, source, target);
    if (!patch) return; // dropped back where it came from

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
    setActiveEntry((event.active.data.current?.entry as BoardEntry | undefined) ?? null);
  }

  function handleDragEnd(event: DragEndEvent) {
    setActiveEntry(null);
    const { active, over } = event;
    if (!over) return;
    const pickup = active.data.current as Pickup | undefined;
    const target = parseBoardTarget(over.id as string, selectedDateKey);
    if (!pickup || !target) return;
    void moveBooking(pickup.bookingId, pickup.source, target, shiftHeld.current ? "add" : "move");
  }

  const onPick = cut ? placeCut : undefined;

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
    setResize({ booking: entry.booking, job: entry.job, edge, delta: 0, phase: "dragging", conflicts: [] });
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
    if (conflicts.length > 0) {
      setResize({ ...current, delta, phase: "confirm", conflicts });
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
    setResize({ ...current, phase: "saving", conflicts: [] });
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
          <ListTodo className="w-3.5 h-3.5" />To-do list{todoJobs.length > 0 ? ` (${todoJobs.length})` : ""}
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
                Moving <span className="font-semibold">#{cutJob.job_number}</span> — click a technician&apos;s day to place it, Esc to cancel
              </span>
            </p>
            <Button size="sm" variant="ghost" className="h-7 gap-1 flex-shrink-0" onClick={() => setCut(null)}>
              <X className="w-3.5 h-3.5" />
              Cancel
            </Button>
          </div>
        ) : (
          <p className="text-xs text-slate-400 mb-3">
            {viewMode === "day"
              ? "Each card is one technician's booking. Press and hold it and drag it onto a technician — or double-click it, then click the technician — to move that booking to them. Hold Shift as you drop to book them on the same time as well."
              : "Each card is one technician's booking. Press and hold it and drag it onto another technician and/or day — or double-click it, then click the cell — to move that booking. Hold Shift as you drop on a technician to book them as well. Drag a booking's left or right edge to change its first or last day."}
          </p>
        )}

        {viewMode === "day" ? (
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
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
                            <DraggableJobCard key={entry.booking.id} entry={entry} source={source} tag={tagFor(entry)} cut={cut} onCut={setCut} />
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
                                "Free"
                              ) : (
                                <>
                                  <span className="font-semibold text-slate-600">{formatHours(hours)}</span>
                                  {` · ${memberEntries.length} job${memberEntries.length === 1 ? "" : "s"}`}
                                </>
                              )}
                            </p>
                          </div>
                        </div>
                      </CardHeader>
                      <CardContent className="space-y-2">
                        {memberEntries.length === 0 ? (
                          <p className="text-slate-400 text-xs text-center py-6 border border-dashed border-slate-200 rounded-lg">
                            No jobs scheduled
                          </p>
                        ) : (
                          memberEntries.map((entry) => (
                            <DraggableJobCard key={entry.booking.id} entry={entry} source={source} tag={tagFor(entry)} cut={cut} onCut={setCut} />
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

            <DragOverlay>
              {activeEntry ? (
                <div className="w-72 shadow-lg rounded-lg rotate-1 bg-white">
                  <div className={JOB_CARD_CLASS}>
                    <JobCardBody entry={activeEntry} tag={tagFor(activeEntry)} />
                  </div>
                </div>
              ) : null}
            </DragOverlay>
          </DndContext>
        ) : (
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
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
                  <DroppableWeekCell key={key} id={weekCellId(null, key)} isToday={key === todayKey} onPick={onPick}>
                    {(board.unassigned.get(key) ?? []).map((entry) => (
                      <DraggableWeekJobChip
                        key={entry.booking.id}
                        entry={entry}
                        source={{ staffId: null, dateKey: key }}
                        tag={tagFor(entry)}
                        cut={cut}
                        onCut={setCut}
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
                          onPick={onPick}
                        >
                          {(memberDays?.get(key) ?? []).map((entry) => (
                            <DraggableWeekJobChip
                              key={entry.booking.id}
                              entry={entry}
                              source={{ staffId: member.id, dateKey: key }}
                              tag={tagFor(entry)}
                              cut={cut}
                              onCut={setCut}
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

            <DragOverlay>
              {activeEntry ? (
                <div className="w-48 shadow-lg rounded-lg rotate-1 bg-white">
                  <div className={WEEK_CHIP_CLASS}>
                    <WeekJobChipBody entry={activeEntry} tag={tagFor(activeEntry)} />
                  </div>
                </div>
              ) : null}
            </DragOverlay>
          </DndContext>
        )}
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
        <TodoListPanel jobs={todoJobs} error={todoError} />
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
                <DialogTitle>{nameOf(resize.booking.staff_id)} is already booked then</DialogTitle>
                <DialogDescription>
                  Stretching #{resize.job.job_number}
                  {resizePlan?.ok && <> to {formatDateKeyRange(resizePlan.startKey, resizePlan.endKey)}</>} overlaps:
                </DialogDescription>
              </DialogHeader>
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
    </Tabs>
  );
}
