"use client";

import Link from "next/link";
import { Fragment, useMemo, useState } from "react";
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
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Navigation, Users, LayoutList, ChevronLeft, ChevronRight, GripVertical, CalendarDays, CalendarRange } from "lucide-react";
import {
  formatTime,
  formatDate,
  dateKeyInBusinessTZ,
  isTodayInBusinessTZ,
  shiftDateKey,
  anchorForDateKey,
  weekDateKeys,
  withDateKeyPreservingTime,
} from "@/lib/date";
import { jobStatusColors } from "@/lib/badge-colors";
import { cn } from "@/lib/utils";

type Job = {
  id: string;
  job_number: number;
  title: string;
  status: string;
  scheduled_start: string | null;
  scheduled_end: string | null;
  assigned_to: string | null;
  customers?: { name?: string } | null;
  profiles?: { full_name?: string } | null;
  sites?: {
    name?: string;
    address_line1?: string;
    suburb?: string;
    state?: string;
    site_lat?: number;
    site_lng?: number;
  } | null;
};

type StaffMember = {
  id: string;
  full_name: string;
  role: string;
};

const UNASSIGNED_COLUMN_ID = "unassigned";
const STAFF_COLUMN_PREFIX = "staff:";
// Week-grid droppable cells encode both "who" and "which day" in one id
// (base column id + this separator + a "YYYY-MM-DD" day key) since a cell
// there is the intersection of a staff/unassigned row and a day column —
// unlike the day board where a column is just "who".
const WEEK_CELL_SEPARATOR = "::";

function weekCellId(base: string, dayKey: string) {
  return `${base}${WEEK_CELL_SEPARATOR}${dayKey}`;
}

function wazeUrl(site: Job["sites"]): string | null {
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

function WazeButton({ site }: { site: Job["sites"] }) {
  const url = wazeUrl(site);
  if (!url) return null;
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(e) => e.stopPropagation()}
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

function JobCard({ job }: { job: Job }) {
  return (
    <Link
      href={`/dashboard/jobs/${job.id}`}
      className="block px-3 py-2.5 rounded-lg border border-slate-200 hover:border-blue-300 hover:bg-blue-50/50 transition-colors group"
    >
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-bold text-blue-600">
          {job.scheduled_start ? (
            <>
              {formatTime(job.scheduled_start)}
              {job.scheduled_end && (
                <span className="text-slate-400 font-medium">
                  {" "}–{" "}
                  {formatTime(job.scheduled_end)}
                </span>
              )}
            </>
          ) : (
            <span className="text-amber-600 font-semibold not-italic">No time set</span>
          )}
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
      <p className="text-xs text-slate-500 truncate">{job.customers?.name}</p>
      <div className="mt-1"><WazeButton site={job.sites} /></div>
    </Link>
  );
}

// Wraps JobCard in a draggable node for the "Team" board. A long-press
// (past the sensor's activation delay) starts a drag; a quick tap still
// passes through to the JobCard's Link as a normal click/navigation.
function DraggableJobCard({ job }: { job: Job }) {
  const { setNodeRef, listeners, isDragging } = useDraggable({ id: job.id });
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
      className={cn("relative cursor-grab active:cursor-grabbing select-none", isDragging && "opacity-30")}
    >
      <GripVertical className="w-3.5 h-3.5 text-slate-300 absolute top-2 right-2 pointer-events-none" />
      <JobCard job={job} />
    </div>
  );
}

function DroppableColumn({
  id,
  className,
  children,
}: {
  id: string;
  className?: string;
  children: React.ReactNode;
}) {
  const { setNodeRef, isOver } = useDroppable({ id });
  return (
    <div ref={setNodeRef} className={cn(className, isOver && "ring-2 ring-blue-400 ring-offset-2")}>
      {children}
    </div>
  );
}

// Compact job entry for a single day cell in the week grid — the grid is
// staff (rows) x day (columns), so each cell is narrow; this trades the
// full JobCard's detail for a glanceable time + job + customer stack.
function WeekJobChip({ job }: { job: Job }) {
  return (
    <Link
      href={`/dashboard/jobs/${job.id}`}
      className="block px-1.5 py-1 rounded-md border border-slate-200 hover:border-blue-300 hover:bg-blue-50/50 transition-colors"
    >
      <p className="text-[10px] font-bold text-blue-600 truncate">
        {job.scheduled_start ? formatTime(job.scheduled_start) : "No time"}
      </p>
      <p className="text-[11px] font-medium text-slate-700 truncate">
        #{job.job_number} {job.title}
      </p>
      {job.customers?.name && <p className="text-[10px] text-slate-400 truncate">{job.customers.name}</p>}
    </Link>
  );
}

// Draggable wrapper for WeekJobChip — same long-press-to-drag pattern as
// DraggableJobCard on the day board, so a quick tap still passes through as
// a normal click/navigation.
function DraggableWeekJobChip({ job }: { job: Job }) {
  const { setNodeRef, listeners, isDragging } = useDraggable({ id: job.id });
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
      className={cn("select-none", isDragging && "opacity-30")}
    >
      <WeekJobChip job={job} />
    </div>
  );
}

// A single (staff-or-unassigned) x (day) cell in the week grid — droppable
// so a job can be dragged both onto a different technician's row and/or a
// different day column at once (reassigning and rescheduling in one drag).
function DroppableWeekCell({
  id,
  isToday,
  children,
}: {
  id: string;
  isToday?: boolean;
  children: React.ReactNode;
}) {
  const { setNodeRef, isOver } = useDroppable({ id });
  return (
    <div
      ref={setNodeRef}
      className={cn(
        "bg-white p-1.5 space-y-1 min-h-[64px] transition-colors",
        isToday && "bg-blue-50/40",
        isOver && "ring-2 ring-inset ring-blue-400 bg-blue-50/70"
      )}
    >
      {children}
    </div>
  );
}

export function TeamScheduleView({
  todayJobs,
  upcomingJobs,
  staff,
}: {
  todayJobs: Job[];
  upcomingJobs: Job[];
  staff: StaffMember[];
}) {
  const supabase = createClient();
  const [tab, setTab] = useState("team");
  // Every job passed in here already has a scheduled_start (the page query
  // filters that) — jobs with no time yet stay in the general Jobs list
  // until someone schedules them, rather than flooding this board's
  // Unassigned column.
  const [jobs, setJobs] = useState<Job[]>(() => [...todayJobs, ...upcomingJobs]);
  const [activeId, setActiveId] = useState<string | null>(null);

  const todayKey = useMemo(() => dateKeyInBusinessTZ(new Date()), []);
  const [selectedDateKey, setSelectedDateKey] = useState(todayKey);
  const [viewMode, setViewMode] = useState<"day" | "week">("day");

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { delay: 200, tolerance: 8 } })
  );

  const todayJobsLive = jobs.filter((j) => isTodayInBusinessTZ(j.scheduled_start!));
  const upcomingJobsLive = jobs.filter((j) => !isTodayInBusinessTZ(j.scheduled_start!));

  const selectedDateJobs = jobs.filter((j) => dateKeyInBusinessTZ(j.scheduled_start!) === selectedDateKey);

  function byScheduleUrgency(a: Job, b: Job) {
    if (!a.scheduled_start || !b.scheduled_start) return 0;
    return new Date(a.scheduled_start).getTime() - new Date(b.scheduled_start).getTime();
  }

  const jobsByStaff = new Map<string, Job[]>();
  const unassigned: Job[] = [];
  for (const job of selectedDateJobs) {
    if (!job.assigned_to) {
      unassigned.push(job);
      continue;
    }
    const list = jobsByStaff.get(job.assigned_to) ?? [];
    list.push(job);
    jobsByStaff.set(job.assigned_to, list);
  }
  unassigned.sort(byScheduleUrgency);

  // Week grid data — staff (rows) x the 7 days (Mon-Sun) containing
  // selectedDateKey. Built the same way as the day board's jobsByStaff/
  // unassigned above, just bucketed by day as well as by staff.
  const weekKeys = useMemo(() => weekDateKeys(selectedDateKey), [selectedDateKey]);
  const weekKeySet = useMemo(() => new Set(weekKeys), [weekKeys]);
  const weekJobs = jobs.filter((j) => weekKeySet.has(dateKeyInBusinessTZ(j.scheduled_start!)));

  const jobsByStaffByDay = new Map<string, Map<string, Job[]>>();
  const unassignedByDay = new Map<string, Job[]>();
  for (const job of weekJobs) {
    const dayKey = dateKeyInBusinessTZ(job.scheduled_start!);
    if (!job.assigned_to) {
      const list = unassignedByDay.get(dayKey) ?? [];
      list.push(job);
      unassignedByDay.set(dayKey, list);
      continue;
    }
    const byDay = jobsByStaffByDay.get(job.assigned_to) ?? new Map<string, Job[]>();
    const list = byDay.get(dayKey) ?? [];
    list.push(job);
    byDay.set(dayKey, list);
    jobsByStaffByDay.set(job.assigned_to, byDay);
  }
  for (const list of unassignedByDay.values()) list.sort(byScheduleUrgency);
  for (const byDay of jobsByStaffByDay.values()) {
    for (const list of byDay.values()) list.sort(byScheduleUrgency);
  }
  const staffWeekJobCount = new Map<string, number>();
  for (const [staffId, byDay] of jobsByStaffByDay) {
    let total = 0;
    for (const list of byDay.values()) total += list.length;
    staffWeekJobCount.set(staffId, total);
  }

  // Staff with the most jobs first (busiest first, in whichever period is
  // currently showing), then everyone else so it's obvious at a glance
  // who's free and could take on more work.
  const sortedStaff = [...staff].sort((a, b) => {
    const countA = viewMode === "week" ? staffWeekJobCount.get(a.id) ?? 0 : jobsByStaff.get(a.id)?.length ?? 0;
    const countB = viewMode === "week" ? staffWeekJobCount.get(b.id) ?? 0 : jobsByStaff.get(b.id)?.length ?? 0;
    const diff = countB - countA;
    if (diff !== 0) return diff;
    return a.full_name.localeCompare(b.full_name);
  });

  const activeJob = activeId ? jobs.find((j) => j.id === activeId) ?? null : null;
  const isSelectedToday = selectedDateKey === todayKey;
  const isCurrentPeriod = viewMode === "week" ? weekKeySet.has(todayKey) : isSelectedToday;
  const selectedDateLabel = formatDate(anchorForDateKey(selectedDateKey), {
    weekday: "long",
    day: "numeric",
    month: "long",
  });
  const weekRangeLabel = useMemo(() => formatWeekRangeLabel(weekKeys), [weekKeys]);

  function handleDragStart(event: DragStartEvent) {
    setActiveId(event.active.id as string);
  }

  function handleDragEnd(event: DragEndEvent) {
    setActiveId(null);
    const { active, over } = event;
    if (!over) return;

    const jobId = active.id as string;
    const overId = over.id as string;
    const newAssignedTo = overId === UNASSIGNED_COLUMN_ID ? null : overId.slice(STAFF_COLUMN_PREFIX.length);

    const job = jobs.find((j) => j.id === jobId);
    if (!job) return;
    if ((job.assigned_to ?? null) === newAssignedTo) return; // dropped back on the same column

    const targetStaff = newAssignedTo ? staff.find((s) => s.id === newAssignedTo) ?? null : null;
    const previousJobs = jobs;

    setJobs((prev) =>
      prev.map((j) =>
        j.id === jobId
          ? { ...j, assigned_to: newAssignedTo, profiles: targetStaff ? { full_name: targetStaff.full_name } : null }
          : j
      )
    );

    supabase
      .from("jobs")
      .update({ assigned_to: newAssignedTo })
      .eq("id", jobId)
      .then(({ error }: { error: { message: string } | null }) => {
        if (error) {
          setJobs(previousJobs);
          toast.error(error.message);
        } else {
          toast.success(targetStaff ? `Assigned to ${targetStaff.full_name}` : "Job unassigned");
        }
      });
  }

  // Week grid drop target ids are "<base>::<dayKey>" (see weekCellId) so a
  // single drag can change who a job's assigned to and/or which day it's
  // scheduled on. Re-dating uses withDateKeyPreservingTime so the
  // time-of-day stays put — only the calendar day moves.
  function handleWeekDragEnd(event: DragEndEvent) {
    setActiveId(null);
    const { active, over } = event;
    if (!over) return;

    const jobId = active.id as string;
    const overId = over.id as string;
    const sepIndex = overId.lastIndexOf(WEEK_CELL_SEPARATOR);
    if (sepIndex === -1) return;
    const base = overId.slice(0, sepIndex);
    const targetDayKey = overId.slice(sepIndex + WEEK_CELL_SEPARATOR.length);
    const newAssignedTo = base === UNASSIGNED_COLUMN_ID ? null : base.slice(STAFF_COLUMN_PREFIX.length);

    const job = jobs.find((j) => j.id === jobId);
    if (!job || !job.scheduled_start) return;

    const currentDayKey = dateKeyInBusinessTZ(job.scheduled_start);
    const assignedChanged = (job.assigned_to ?? null) !== newAssignedTo;
    const dayChanged = currentDayKey !== targetDayKey;
    if (!assignedChanged && !dayChanged) return; // dropped back on the same cell

    const targetStaff = newAssignedTo ? staff.find((s) => s.id === newAssignedTo) ?? null : null;
    const previousJobs = jobs;

    const newStart = dayChanged ? withDateKeyPreservingTime(job.scheduled_start, targetDayKey) : job.scheduled_start;
    const newEnd =
      dayChanged && job.scheduled_end
        ? new Date(
            new Date(newStart).getTime() + (new Date(job.scheduled_end).getTime() - new Date(job.scheduled_start).getTime())
          ).toISOString()
        : job.scheduled_end;

    setJobs((prev) =>
      prev.map((j) =>
        j.id === jobId
          ? {
              ...j,
              assigned_to: newAssignedTo,
              scheduled_start: newStart,
              scheduled_end: newEnd,
              profiles: targetStaff ? { full_name: targetStaff.full_name } : null,
            }
          : j
      )
    );

    supabase
      .from("jobs")
      .update({ assigned_to: newAssignedTo, scheduled_start: newStart, scheduled_end: newEnd })
      .eq("id", jobId)
      .then(({ error }: { error: { message: string } | null }) => {
        if (error) {
          setJobs(previousJobs);
          toast.error(error.message);
          return;
        }
        const changes: string[] = [];
        if (assignedChanged) changes.push(targetStaff ? `assigned to ${targetStaff.full_name}` : "unassigned");
        if (dayChanged) changes.push(`moved to ${formatDate(anchorForDateKey(targetDayKey))}`);
        toast.success(`Job ${changes.join(" and ")}`);
      });
  }

  return (
    <Tabs value={tab} onValueChange={(v) => typeof v === "string" && setTab(v)}>
      <TabsList variant="line">
        <TabsTrigger value="team" className="gap-1.5"><Users className="w-3.5 h-3.5" />Team</TabsTrigger>
        <TabsTrigger value="list" className="gap-1.5"><LayoutList className="w-3.5 h-3.5" />List</TabsTrigger>
      </TabsList>

      <TabsContent value="team" className="mt-4">
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

          <div className="inline-flex rounded-md border border-slate-200 p-0.5 bg-slate-50">
            <Button
              size="sm"
              variant={viewMode === "day" ? "default" : "ghost"}
              className="h-7 px-3 gap-1.5"
              onClick={() => setViewMode("day")}
            >
              <CalendarDays className="w-3.5 h-3.5" />
              Day
            </Button>
            <Button
              size="sm"
              variant={viewMode === "week" ? "default" : "ghost"}
              className="h-7 px-3 gap-1.5"
              onClick={() => setViewMode("week")}
            >
              <CalendarRange className="w-3.5 h-3.5" />
              Week
            </Button>
          </div>
        </div>

        {viewMode === "day" ? (
          <>
            <p className="text-xs text-slate-400 mb-3">Press and hold a job, then drag it onto a technician to assign it.</p>

            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
              <div className="flex gap-4 overflow-x-auto pb-2">
                <DroppableColumn id={UNASSIGNED_COLUMN_ID} className="w-72 flex-shrink-0 rounded-xl sticky left-0 z-10 bg-slate-50 shadow-[4px_0_8px_-4px_rgba(0,0,0,0.08)]">
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
                            {unassigned.length === 0 ? "Drop a job here to unassign" : `${unassigned.length} job${unassigned.length === 1 ? "" : "s"} need a tech`}
                          </p>
                        </div>
                      </div>
                    </CardHeader>
                    <CardContent className="space-y-2">
                      {unassigned.length === 0 ? (
                        <p className="text-slate-400 text-xs text-center py-6 border border-dashed border-slate-200 rounded-lg">
                          No unassigned jobs
                        </p>
                      ) : (
                        unassigned.map((job) => <DraggableJobCard key={job.id} job={job} />)
                      )}
                    </CardContent>
                  </Card>
                </DroppableColumn>

                {sortedStaff.map((member) => {
                  const memberJobs = (jobsByStaff.get(member.id) ?? []).slice().sort(byScheduleUrgency);
                  return (
                    <DroppableColumn key={member.id} id={`${STAFF_COLUMN_PREFIX}${member.id}`} className="w-72 flex-shrink-0 rounded-xl">
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
                                {memberJobs.length === 0 ? "Free" : `${memberJobs.length} job${memberJobs.length === 1 ? "" : "s"}`}
                              </p>
                            </div>
                          </div>
                        </CardHeader>
                        <CardContent className="space-y-2">
                          {memberJobs.length === 0 ? (
                            <p className="text-slate-400 text-xs text-center py-6 border border-dashed border-slate-200 rounded-lg">
                              No jobs scheduled
                            </p>
                          ) : (
                            memberJobs.map((job) => <DraggableJobCard key={job.id} job={job} />)
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
            {activeJob ? (
              <div className="w-72 shadow-lg rounded-lg rotate-1">
                <JobCard job={activeJob} />
              </div>
            ) : null}
          </DragOverlay>
        </DndContext>
          </>
        ) : (
          <>
            <p className="text-xs text-slate-400 mb-3">
              Press and hold a job, then drag it onto another technician and/or another day to reassign and/or reschedule it.
            </p>

            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragStart={handleDragStart} onDragEnd={handleWeekDragEnd}>
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
                    <DroppableWeekCell key={key} id={weekCellId(UNASSIGNED_COLUMN_ID, key)} isToday={key === todayKey}>
                      {(unassignedByDay.get(key) ?? []).map((job) => (
                        <DraggableWeekJobChip key={job.id} job={job} />
                      ))}
                    </DroppableWeekCell>
                  ))}

                  {sortedStaff.map((member) => (
                    <Fragment key={member.id}>
                      <div className="bg-white p-2 flex items-center gap-2 min-w-0">
                        <Avatar className="w-6 h-6 flex-shrink-0">
                          <AvatarFallback className={`text-white text-[10px] ${accentFor(member.id)}`}>
                            {initials(member.full_name)}
                          </AvatarFallback>
                        </Avatar>
                        <span className="text-xs font-medium text-slate-700 truncate">{member.full_name}</span>
                      </div>
                      {weekKeys.map((key) => (
                        <DroppableWeekCell
                          key={key}
                          id={weekCellId(`${STAFF_COLUMN_PREFIX}${member.id}`, key)}
                          isToday={key === todayKey}
                        >
                          {(jobsByStaffByDay.get(member.id)?.get(key) ?? []).map((job) => (
                            <DraggableWeekJobChip key={job.id} job={job} />
                          ))}
                        </DroppableWeekCell>
                      ))}
                    </Fragment>
                  ))}
                </div>

                {sortedStaff.length === 0 && (
                  <p className="text-slate-400 text-sm py-4">No active staff found.</p>
                )}
              </div>

              <DragOverlay>
                {activeJob ? (
                  <div className="w-48 shadow-lg rounded-lg rotate-1 bg-white">
                    <WeekJobChip job={activeJob} />
                  </div>
                ) : null}
              </DragOverlay>
            </DndContext>
          </>
        )}
      </TabsContent>

      <TabsContent value="list" className="mt-4 space-y-6">
        <Card>
          <CardHeader><CardTitle className="text-base">Today</CardTitle></CardHeader>
          <CardContent className="p-0">
            {todayJobsLive.length === 0 ? (
              <p className="text-slate-400 text-sm text-center py-8">No jobs scheduled for today</p>
            ) : (
              <div className="divide-y">
                {todayJobsLive.map((job) => (
                  <Link key={job.id} href={`/dashboard/jobs/${job.id}`} className="flex items-center gap-4 px-6 py-4 hover:bg-slate-50 transition-colors group">
                    <div className="text-center w-16 flex-shrink-0">
                      <p className="text-xs font-bold text-blue-600">{formatTime(job.scheduled_start!)}</p>
                      {job.scheduled_end && <p className="text-xs text-slate-400">{formatTime(job.scheduled_end)}</p>}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="font-medium text-sm group-hover:text-blue-600 transition-colors truncate">#{job.job_number} — {job.title}</p>
                      <p className="text-xs text-slate-500 truncate">{job.customers?.name} {job.profiles?.full_name ? `· ${job.profiles.full_name}` : ""}</p>
                    </div>
                    <WazeButton site={job.sites} />
                    <span className={`text-xs px-2 py-0.5 rounded-full font-medium capitalize flex-shrink-0 ${jobStatusColors[job.status] ?? ""}`}>
                      {job.status.replace("_", " ")}
                    </span>
                  </Link>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {upcomingJobsLive.length > 0 && (
          <Card>
            <CardHeader><CardTitle className="text-base">Upcoming</CardTitle></CardHeader>
            <CardContent className="p-0">
              <div className="divide-y">
                {upcomingJobsLive.map((job) => (
                  <Link key={job.id} href={`/dashboard/jobs/${job.id}`} className="flex items-center gap-4 px-6 py-4 hover:bg-slate-50 transition-colors group">
                    <div className="text-center w-20 flex-shrink-0">
                      <p className="text-xs font-bold text-slate-700">{formatDate(job.scheduled_start!)}</p>
                      <p className="text-xs text-slate-400">{formatTime(job.scheduled_start!)}</p>
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="font-medium text-sm group-hover:text-blue-600 transition-colors truncate">#{job.job_number} — {job.title}</p>
                      <p className="text-xs text-slate-500 truncate">{job.customers?.name} {job.profiles?.full_name ? `· ${job.profiles.full_name}` : ""}</p>
                    </div>
                    <WazeButton site={job.sites} />
                  </Link>
                ))}
              </div>
            </CardContent>
          </Card>
        )}
      </TabsContent>
    </Tabs>
  );
}
