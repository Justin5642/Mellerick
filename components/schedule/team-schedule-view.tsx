"use client";

import Link from "next/link";
import { useState } from "react";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Navigation, Users, LayoutList } from "lucide-react";
import { formatTime, formatDate } from "@/lib/date";

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
          className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium capitalize flex-shrink-0 ${
            job.status === "in_progress" ? "bg-purple-100 text-purple-800" : "bg-blue-100 text-blue-800"
          }`}
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

export function TeamScheduleView({
  todayJobs,
  upcomingJobs,
  staff,
}: {
  todayJobs: Job[];
  upcomingJobs: Job[];
  staff: StaffMember[];
}) {
  const [tab, setTab] = useState("team");

  const jobsByStaff = new Map<string, Job[]>();
  const unassigned: Job[] = [];
  for (const job of todayJobs) {
    if (!job.assigned_to) {
      unassigned.push(job);
      continue;
    }
    const list = jobsByStaff.get(job.assigned_to) ?? [];
    list.push(job);
    jobsByStaff.set(job.assigned_to, list);
  }

  // Staff with jobs today first (busiest first), then everyone else so
  // it's obvious at a glance who's free and could take on more work.
  const sortedStaff = [...staff].sort((a, b) => {
    const diff = (jobsByStaff.get(b.id)?.length ?? 0) - (jobsByStaff.get(a.id)?.length ?? 0);
    if (diff !== 0) return diff;
    return a.full_name.localeCompare(b.full_name);
  });

  return (
    <Tabs value={tab} onValueChange={(v) => typeof v === "string" && setTab(v)}>
      <TabsList variant="line">
        <TabsTrigger value="team" className="gap-1.5"><Users className="w-3.5 h-3.5" />Team Today</TabsTrigger>
        <TabsTrigger value="list" className="gap-1.5"><LayoutList className="w-3.5 h-3.5" />List</TabsTrigger>
      </TabsList>

      <TabsContent value="team" className="mt-4">
        <div className="flex gap-4 overflow-x-auto pb-2">
          {unassigned.length > 0 && (
            <Card className="w-72 flex-shrink-0 border-amber-300">
              <CardHeader className="pb-3">
                <div className="flex items-center gap-2">
                  <div className="w-8 h-8 rounded-full bg-amber-100 flex items-center justify-center flex-shrink-0">
                    <span className="text-amber-700 text-xs font-bold">!</span>
                  </div>
                  <div className="min-w-0">
                    <CardTitle className="text-sm truncate">Unassigned</CardTitle>
                    <p className="text-xs text-amber-600">{unassigned.length} job{unassigned.length === 1 ? "" : "s"} need a tech</p>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="space-y-2">
                {unassigned.map((job) => <JobCard key={job.id} job={job} />)}
              </CardContent>
            </Card>
          )}

          {sortedStaff.map((member) => {
            const jobs = (jobsByStaff.get(member.id) ?? []).slice().sort(
              (a, b) => new Date(a.scheduled_start).getTime() - new Date(b.scheduled_start).getTime()
            );
            return (
              <Card key={member.id} className="w-72 flex-shrink-0">
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
                        {jobs.length === 0 ? "Free today" : `${jobs.length} job${jobs.length === 1 ? "" : "s"} today`}
                      </p>
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="space-y-2">
                  {jobs.length === 0 ? (
                    <p className="text-slate-400 text-xs text-center py-6 border border-dashed border-slate-200 rounded-lg">
                      No jobs scheduled
                    </p>
                  ) : (
                    jobs.map((job) => <JobCard key={job.id} job={job} />)
                  )}
                </CardContent>
              </Card>
            );
          })}

          {sortedStaff.length === 0 && unassigned.length === 0 && (
            <p className="text-slate-400 text-sm py-8">No active staff found.</p>
          )}
        </div>
      </TabsContent>

      <TabsContent value="list" className="mt-4 space-y-6">
        <Card>
          <CardHeader><CardTitle className="text-base">Today</CardTitle></CardHeader>
          <CardContent className="p-0">
            {todayJobs.length === 0 ? (
              <p className="text-slate-400 text-sm text-center py-8">No jobs scheduled for today</p>
            ) : (
              <div className="divide-y">
                {todayJobs.map((job) => (
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
                    <span className={`text-xs px-2 py-0.5 rounded-full font-medium capitalize flex-shrink-0 ${job.status === "in_progress" ? "bg-purple-100 text-purple-800" : "bg-blue-100 text-blue-800"}`}>
                      {job.status.replace("_", " ")}
                    </span>
                  </Link>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {upcomingJobs.length > 0 && (
          <Card>
            <CardHeader><CardTitle className="text-base">Upcoming</CardTitle></CardHeader>
            <CardContent className="p-0">
              <div className="divide-y">
                {upcomingJobs.map((job) => (
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
