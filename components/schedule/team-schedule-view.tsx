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
// (triggers in 0079, a draft not applied yet), so nothing here writes
// assigned_to, job_assignments or jobs.scheduled_* any more.
import { pushJobToCalendar } from "@/lib/schedule-dispatch";
import { insertBookings, updateBooking, type BookingWriteClient } from "@/lib/bookings";
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
  formatHours,
  jobDaysFromBookings,
  parseBoardTarget,
  planBoardMove,
  planBoardAdd,
  totalHours,
  weekCellId,
  type BoardBooking,
  type BoardCell,
  type BoardEntry,
  type BoardJob,
  type BookingPatch,
} from "./board-model";
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

/** Props every placed card shares: where it sits, and the cut-mode wiring. */
type PlacedProps = {
  entry: BoardEntry;
  source: BoardCell;
  cut: Pickup | null;
  onCut: (pickup: Pickup) => void;
};

function isCutHere(cut: Pickup | null, bookingId: string, source: BoardCell) {
  return !!cut && cut.bookingId === bookingId && cut.source.staffId === source.staffId && cut.source.dateKey === source.dateKey;
}

function JobCardBody({ entry }: { entry: BoardEntry }) {
  const { job, booking } = entry;
  const dayOf = dayOfLabel(entry);
  return (
    <>
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-bold text-blue-600">
          <EntryTime entry={entry} />
        </p>
        <span
          className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium capitalize flex-shrink-0 ${jobStatusColors[job.status] ?? ""}`}
        >
          {job.status.replace("_", " ")}
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
  "block px-3 py-2.5 rounded-lg border border-slate-200 hover:border-blue-300 hover:bg-blue-50/50 transition-colors group";

// Wraps a job card in a draggable node for the Day board. A long-press (past
// the sensor's activation delay) starts a drag; a quick tap opens the job; a
// double-click cuts it for pasting (BoardJobLink).
//
// The draggable id is per PLACEMENT, not per booking: a multi-day booking
// sits in several day cells at once and dnd-kit needs each node's id to be
// unique.
function DraggableJobCard({ entry, source, cut, onCut }: PlacedProps) {
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
        <JobCardBody entry={entry} />
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
function WeekJobChipBody({ entry }: { entry: BoardEntry }) {
  const { job, booking } = entry;
  const dayOf = dayOfLabel(entry);
  return (
    <>
      <p className="text-[10px] font-bold text-blue-600 truncate">
        {formatTime(entry.day.startIso)}
        {entry.day.endIso !== entry.day.startIso && `–${formatTime(entry.day.endIso)}`}
      </p>
      <p className="text-[11px] font-medium text-slate-700 truncate">
        #{job.job_number} {job.title}
      </p>
      {booking.cost_center_name && <p className="text-[10px] font-medium text-cyan-700 truncate">{booking.cost_center_name}</p>}
      {dayOf && <p className="text-[10px] font-medium text-violet-600 truncate">{dayOf}</p>}
      {job.customers?.name && <p className="text-[10px] text-slate-400 truncate">{job.customers.name}</p>}
    </>
  );
}

const WEEK_CHIP_CLASS =
  "block px-1.5 py-1 rounded-md border border-slate-200 hover:border-blue-300 hover:bg-blue-50/50 transition-colors";

// Draggable wrapper for a week chip — same long-press-to-drag and
// double-click-to-cut pattern as DraggableJobCard on the day board. One per
// placement: two technicians each booked Mon–Wed on a job show six chips.
function DraggableWeekJobChip({ entry, source, cut, onCut }: PlacedProps) {
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
      className={cn("select-none rounded-md", isDragging && "opacity-30", isCut && "ring-2 ring-amber-400 bg-amber-50/60")}
    >
      <BoardJobLink
        href={`/dashboard/jobs/${job.id}`}
        className={WEEK_CHIP_CLASS}
        cutActive={!!cut}
        onCut={() => onCut({ bookingId: booking.id, source })}
      >
        <WeekJobChipBody entry={entry} />
      </BoardJobLink>
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
  const board = useMemo(
    () => buildBoardIndex(bookings, jobsById, visibleKeys, bookingDays),
    [bookings, jobsById, visibleKeys, bookingDays],
  );

  // Booked hours per technician over the period showing — one day, or the
  // week's total.
  const periodHours = useMemo(() => {
    const totals = new Map<string, number>();
    for (const [staffId, byDay] of board.hours) totals.set(staffId, totalHours(byDay));
    return totals;
  }, [board]);

  // Busiest first (most booked hours in whichever period is showing), then
  // everyone else so it's obvious at a glance who's free and could take on
  // more work.
  const sortedStaff = useMemo(
    () =>
      [...staff].sort((a, b) => {
        const diff = (periodHours.get(b.id) ?? 0) - (periodHours.get(a.id) ?? 0);
        if (diff !== 0) return diff;
        return a.full_name.localeCompare(b.full_name);
      }),
    [staff, periodHours],
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

        {cutJob ? (
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
              : "Each card is one technician's booking. Press and hold it and drag it onto another technician and/or day — or double-click it, then click the cell — to move that booking. Hold Shift as you drop on a technician to book them as well."}
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
                            <DraggableJobCard key={entry.booking.id} entry={entry} source={source} cut={cut} onCut={setCut} />
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
                            <DraggableJobCard key={entry.booking.id} entry={entry} source={source} cut={cut} onCut={setCut} />
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
                    <JobCardBody entry={activeEntry} />
                  </div>
                </div>
              ) : null}
            </DragOverlay>
          </DndContext>
        ) : (
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
            <div className="overflow-x-auto pb-2">
              <div
                className="grid min-w-[960px] rounded-xl border border-slate-200 bg-slate-200 gap-px overflow-hidden"
                style={{ gridTemplateColumns: "160px repeat(7, minmax(120px, 1fr))" }}
              >
                <div className="bg-white p-2" />
                {weekKeys.map((key) => (
                  <div key={key} className={cn("bg-white p-2 text-center", key === todayKey && "bg-blue-50")}>
                    <p className="text-xs font-semibold text-slate-900">
                      {formatDate(anchorForDateKey(key), { weekday: "short" })}
                    </p>
                    <p className="text-[11px] text-slate-400">
                      {formatDate(anchorForDateKey(key), { day: "numeric", month: "short" })}
                    </p>
                  </div>
                ))}

                <div className="bg-white p-2 flex items-center gap-2 min-w-0">
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
                        cut={cut}
                        onCut={setCut}
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
                      <div className="bg-white p-2 flex items-center gap-2 min-w-0">
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
                              cut={cut}
                              onCut={setCut}
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
                    <WeekJobChipBody entry={activeEntry} />
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
    </Tabs>
  );
}
