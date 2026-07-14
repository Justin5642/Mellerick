"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { Card, CardContent } from "@/components/ui/card";
import { Briefcase, Clock, MapPin, Navigation } from "lucide-react";
import Link from "next/link";
import { formatTime, formatDate, isTodayInBusinessTZ } from "@/lib/date";
import { ListPageSkeleton } from "@/components/ui/loading-skeletons";
import { jobStatusColors } from "@/lib/badge-colors";

export default function MyJobsPage() {
  const supabase = createClient();
  const [jobs, setJobs] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;

      const { data } = await supabase
        .from("jobs")
        .select("*, customers(name), sites(name, address_line1, suburb, state, site_lat, site_lng)")
        .eq("assigned_to", user.id)
        .not("status", "in", '("completed","cancelled")')
        .order("scheduled_start", { ascending: true, nullsFirst: false });

      setJobs(data ?? []);
      setLoading(false);
    }
    load();
  }, []);

  if (loading) return <ListPageSkeleton />;

  const todayJobs = jobs.filter(j => j.scheduled_start && isTodayInBusinessTZ(j.scheduled_start));
  const upcomingJobs = jobs.filter(j => !j.scheduled_start || !isTodayInBusinessTZ(j.scheduled_start));

  function JobCard({ job }: { job: any }) {
    const address = job.sites
      ? `${job.sites.address_line1}, ${job.sites.suburb}`
      : null;
    const wazeUrl = job.sites?.site_lat && job.sites?.site_lng
      ? `https://waze.com/ul?ll=${job.sites.site_lat},${job.sites.site_lng}&navigate=yes`
      : address
      ? `https://waze.com/ul?q=${encodeURIComponent(address)}&navigate=yes`
      : null;

    return (
      <div className="flex items-start justify-between px-6 py-4 hover:bg-slate-50 transition-colors">
        <Link href={`/dashboard/jobs/${job.id}`} className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <p className="font-medium text-sm text-slate-900">#{job.job_number} — {job.title}</p>
            <span className={`text-xs px-2 py-0.5 rounded-full font-medium capitalize ${jobStatusColors[job.status]}`}>
              {job.status.replace("_", " ")}
            </span>
          </div>
          <p className="text-xs text-slate-500 mt-0.5">{job.customers?.name}</p>
          {address && (
            <p className="text-xs text-slate-400 flex items-center gap-1 mt-0.5">
              <MapPin className="w-3 h-3" />{address}
            </p>
          )}
          {job.scheduled_start && (
            <p className="text-xs text-slate-400 flex items-center gap-1 mt-0.5">
              <Clock className="w-3 h-3" />{formatTime(job.scheduled_start)}
              {job.scheduled_end ? ` — ${formatTime(job.scheduled_end)}` : ""}
            </p>
          )}
        </Link>
        {wazeUrl && (
          <a href={wazeUrl} target="_blank" rel="noopener noreferrer" className="ml-4 shrink-0">
            <div className="flex items-center gap-1.5 text-xs font-medium text-blue-600 border border-blue-200 rounded-lg px-3 py-1.5 hover:bg-blue-50 transition-colors">
              <Navigation className="w-3.5 h-3.5" />Waze
            </div>
          </a>
        )}
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6 max-w-2xl">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">My Jobs</h1>
        <p className="text-slate-500 text-sm mt-1">{formatDate(new Date(), { weekday: "long", day: "numeric", month: "long" })}</p>
      </div>

      {/* Today */}
      <div>
        <h2 className="text-sm font-semibold text-slate-500 uppercase tracking-wide mb-3">Today</h2>
        <Card>
          <CardContent className="p-0">
            {todayJobs.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-10 text-slate-400">
                <Briefcase className="w-8 h-8 mb-2 opacity-40" />
                <p className="text-sm">No jobs scheduled for today</p>
              </div>
            ) : (
              <div className="divide-y">
                {todayJobs.map(job => <JobCard key={job.id} job={job} />)}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Upcoming */}
      {upcomingJobs.length > 0 && (
        <div>
          <h2 className="text-sm font-semibold text-slate-500 uppercase tracking-wide mb-3">Upcoming</h2>
          <Card>
            <CardContent className="p-0">
              <div className="divide-y">
                {upcomingJobs.map(job => (
                  <div key={job.id}>
                    {job.scheduled_start && (
                      <p className="text-xs font-medium text-slate-400 px-6 pt-3">{formatDate(job.scheduled_start, { weekday: "short", day: "numeric", month: "short" })}</p>
                    )}
                    <JobCard job={job} />
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {jobs.length === 0 && (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-16 text-slate-400">
            <Briefcase className="w-12 h-12 mb-3 opacity-40" />
            <p className="text-sm font-medium">No jobs assigned to you</p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
