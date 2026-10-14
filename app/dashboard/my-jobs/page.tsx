export const dynamic = "force-dynamic";

import { getViewer } from "@/lib/auth/viewer";
import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import { Card, CardContent } from "@/components/ui/card";
import { Briefcase, Clock, MapPin, Navigation } from "lucide-react";
import Link from "next/link";
import { formatTime, formatDate, isTodayInBusinessTZ } from "@/lib/date";
import { jobStatusColors } from "@/lib/badge-colors";

// Only what the cards below render. Technicians land here, so the job row is
// named column by column rather than "*" — nothing on it they do not see.
const JOB_COLUMNS =
  "id, job_number, title, status, scheduled_start, scheduled_end, customers(name), sites(address_line1, suburb, site_lat, site_lng)";

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
      <Link prefetch={false} href={`/dashboard/jobs/${job.id}`} className="flex-1 min-w-0">
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

export default async function MyJobsPage() {
  const viewer = await getViewer();
  const user = viewer?.user;
  if (!user) redirect("/login");

  const supabase = await createClient();

  // "Mine" is ANY current assignee (job_assignments, migration 0059), not
  // just jobs.assigned_to — that column only names the crew's primary, so
  // filtering on it alone hid crew jobs from everyone else on the crew.
  // Same rule as user_can_manage_job() and the mobile My Jobs list.
  //
  // The two halves run in parallel and are merged here, rather than reading
  // the crew's job ids first and feeding them into a second jobs query: same
  // rows, one database round trip instead of two in sequence.
  const [{ data: primary }, { data: crew }] = await Promise.all([
    supabase
      .from("jobs")
      .select(JOB_COLUMNS)
      .eq("assigned_to", user.id)
      .not("status", "in", '("completed","cancelled")'),
    supabase
      .from("job_assignments")
      .select(`jobs!inner(${JOB_COLUMNS})`)
      .eq("staff_id", user.id)
      .not("jobs.status", "in", '("completed","cancelled")'),
  ]);

  const byId = new Map<string, any>();
  for (const job of primary ?? []) byId.set(job.id, job);
  for (const row of (crew ?? []) as any[]) if (row.jobs) byId.set(row.jobs.id, row.jobs);

  // The database used to sort this: scheduled_start ascending, unscheduled last.
  const jobs = [...byId.values()].sort((a, b) => {
    if (!a.scheduled_start) return b.scheduled_start ? 1 : 0;
    if (!b.scheduled_start) return -1;
    return new Date(a.scheduled_start).getTime() - new Date(b.scheduled_start).getTime();
  });

  const todayJobs = jobs.filter(j => j.scheduled_start && isTodayInBusinessTZ(j.scheduled_start));
  const upcomingJobs = jobs.filter(j => !j.scheduled_start || !isTodayInBusinessTZ(j.scheduled_start));

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
