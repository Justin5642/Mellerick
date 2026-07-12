import { createClient } from "@/lib/supabase/server";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Calendar, Plus, Navigation } from "lucide-react";
import Link from "next/link";

function wazeUrl(site: any): string | null {
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

function WazeButton({ site }: { site: any }) {
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

export default async function SchedulePage() {
  const supabase = await createClient();
  const { data: jobs } = await supabase
    .from("jobs")
    .select("*, customers(name), profiles(full_name), sites(name, address_line1, suburb, state, site_lat, site_lng)")
    .not("scheduled_start", "is", null)
    .in("status", ["scheduled", "in_progress", "pending"])
    .order("scheduled_start");

  const today = new Date();
  const todayStr = today.toDateString();

  const todayJobs = jobs?.filter((j: any) => new Date(j.scheduled_start).toDateString() === todayStr) ?? [];
  const upcomingJobs = jobs?.filter((j: any) => new Date(j.scheduled_start).toDateString() !== todayStr) ?? [];

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Schedule</h1>
          <p className="text-slate-500 text-sm mt-1">{jobs?.length ?? 0} scheduled jobs</p>
        </div>
        <Link href="/dashboard/jobs/new">
          <Button className="gap-2"><Plus className="w-4 h-4" />Schedule Job</Button>
        </Link>
      </div>

      <Card>
        <CardHeader><CardTitle className="text-base">Today — {today.toLocaleDateString("en-AU", { weekday: "long", day: "numeric", month: "long" })}</CardTitle></CardHeader>
        <CardContent className="p-0">
          {todayJobs.length === 0 ? (
            <p className="text-slate-400 text-sm text-center py-8">No jobs scheduled for today</p>
          ) : (
            <div className="divide-y">
              {todayJobs.map((job: any) => (
                <Link key={job.id} href={`/dashboard/jobs/${job.id}`} className="flex items-center gap-4 px-6 py-4 hover:bg-slate-50 transition-colors group">
                  <div className="text-center w-16 flex-shrink-0">
                    <p className="text-xs font-bold text-blue-600">{new Date(job.scheduled_start).toLocaleTimeString("en-AU", { hour: "2-digit", minute: "2-digit" })}</p>
                    {job.scheduled_end && <p className="text-xs text-slate-400">{new Date(job.scheduled_end).toLocaleTimeString("en-AU", { hour: "2-digit", minute: "2-digit" })}</p>}
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
              {upcomingJobs.map((job: any) => (
                <Link key={job.id} href={`/dashboard/jobs/${job.id}`} className="flex items-center gap-4 px-6 py-4 hover:bg-slate-50 transition-colors group">
                  <div className="text-center w-20 flex-shrink-0">
                    <p className="text-xs font-bold text-slate-700">{new Date(job.scheduled_start).toLocaleDateString("en-AU", { day: "numeric", month: "short" })}</p>
                    <p className="text-xs text-slate-400">{new Date(job.scheduled_start).toLocaleTimeString("en-AU", { hour: "2-digit", minute: "2-digit" })}</p>
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
    </div>
  );
}
