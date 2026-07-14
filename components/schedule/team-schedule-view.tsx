"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
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
import { Navigation, Users, LayoutList, ChevronLeft, ChevronRight, GripVertical } from "lucide-react";
import { formatTime, formatDate, dateKeyInBusinessTZ, isTodayInBusinessTZ } from "@/lib/date";
import { jobStatusColors } from "@/lib/badge-colors";
import { cn } from "@/lib/utils";

type Job = {
  id: string;
  job_number: number;
  title: string;
  status: string;
  scheduled_start: string;
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

// A stable "one day forward/back" step that stays on the same Melbourne
// calendar date regardless of DST — anchoring at UTC noon means the
// Melbourne-local clock is always somewhere between 22:00-23:00 the same
// day (offset is always +10 or +11), so it never rolls over a date line.
function shiftDateKey(key: string, days: number) {
  const [y, m, d] = key.split("-").map(Number);
  const anchor = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  anchor.setUTCDate(anchor.getUTCDate() + days);
  return dateKeyInBusinessTZ(anchor);
}

function anchorForDateKey(key: string) {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
}

function JobCard({ job }: { job: Job }) {
  return (
    <Link
      href={`/dashboard/jobs/${job.id}`}
      className="block px-3 py-2.5 rounded-lg border border-slate-200 hover:border-blue-300 hover:bg-blue-50/50 transition-colors group"
    >
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-bold text-blue-600">
          {formatTime(job.scheduled_start)}
          {job.scheduled_end && (
            <span className="text-slate-400 font-medium">
              {" "}–{" "}
              {formatTime(job.scheduled_end)}
            </span>
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
      style={{ touchAction: "manipulation" }}
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
  const [jobs, setJobs] = useState<Job[]>(() => [...todayJobs, ...upcomingJobs]);
  const [activeId, setActiveId] = useState<string | null>(null);

  const todayKey = useMemo(() => dateKeyInBusinessTZ(new Date()), []);
  const [selectedDateKey, setSelectedDateKey] = useState(todayKey);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { delay: 200, tolerance: 8 } })
  );

  const todayJobsLive = jobs.filter((j) => isTodayInBusinessTZ(j.scheduled_start));
  const upcomingJobsLive = jobs.filter((j) => !isTodayInBusinessTZ(j.scheduled_start));

  const selectedDateJobs = jobs.filter((j) => dateKeyInBusinessTZ(j.scheduled_start) === selectedDateKey);

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

  // Staff with jobs on the selected day first (busiest first), then
  // everyone else so it's obvious at a glance who's free and could take
  // on more work.
  const sortedStaff = [...staff].sort((a, b) => {
    const diff = (jobsByStaff.get(b.id)?.length ?? 0) - (jobsByStaff.get(a.id)?.length ?? 0);
    if (diff !== 0) return diff;
    return a.full_name.localeCompare(b.full_name);
  });

  const activeJob = activeId ? jobs.find((j) => j.id === activeId) ?? null : null;
  const isSelectedToday = selectedDateKey === todayKey;
  const selectedDateLabel = formatDate(anchorForDateKey(selectedDateKey), {
    weekday: "long",
    day: "numeric",
    month: "long",
  });

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

  return (
    <Tabs value={tab} onValueChange={(v) => typeof v === "string" && setTab(v)}>
      <TabsList variant="line">
        <TabsTrigger value="team" className="gap-1.5"><Users className="w-3.5 h-3.5" />Team</TabsTrigger>
        <TabsTrigger value="list" className="gap-1.5"><LayoutList className="w-3.5 h-3.5" />List</TabsTrigger>
      </TabsList>

      <TabsContent value="team" className="mt-4">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <Button variant="outline" size="icon" aria-label="Previous day" onClick={() => setSelectedDateKey((k) => shiftDateKey(k, -1))}>
              <ChevronLeft className="w-4 h-4" />
            </Button>
            <p className="text-sm font-medium text-slate-900 min-w-[180px] text-center">
              {selectedDateLabel}
              {isSelectedToday && <span className="text-blue-600"> · Today</span>}
            </p>
            <Button variant="outline" size="icon" aria-label="Next day" onClick={() => setSelectedDateKey((k) => shiftDateKey(k, 1))}>
              <ChevronRight className="w-4 h-4" />
            </Button>
          </div>
          {!isSelectedToday && (
            <Button variant="ghost" size="sm" onClick={() => setSelectedDateKey(todayKey)}>
              Jump to today
            </Button>
          )}
        </div>

        <p className="text-xs text-slate-400 mb-3">Press and hold a job, then drag it onto a technician to assign it.</p>

        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
          <div className="flex gap-4 overflow-x-auto pb-2">
            <DroppableColumn id={UNASSIGNED_COLUMN_ID} className="w-72 flex-shrink-0 rounded-xl">
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
              const memberJobs = (jobsByStaff.get(member.id) ?? []).slice().sort(
                (a, b) => new Date(a.scheduled_start).getTime() - new Date(b.scheduled_start).getTime()
              );
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
                      <p className="text-xs font-bold text-blue-600">{formatTime(job.scheduled_start)}</p>
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
                      <p className="text-xs font-bold text-slate-700">{formatDate(job.scheduled_start)}</p>
                      <p className="text-xs text-slate-400">{formatTime(job.scheduled_start)}</p>
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
