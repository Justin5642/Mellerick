export const dynamic = "force-dynamic";

import { getViewer } from "@/lib/auth/viewer";
import { createClient } from "@/lib/supabase/server";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Briefcase, Users, Receipt, AlertCircle, CheckCircle2, Clock, DollarSign, Droplets } from "lucide-react";
import Link from "next/link";
import { businessDateParts, dateKeyInBusinessTZ, formatDate, formatTime, fromBusinessInputValue, shiftDateKey } from "@/lib/date";
import { jobStatusColors, jobPriorityColors } from "@/lib/badge-colors";
import { computeNextDueDate, getDueStatus } from "@/lib/backflow";
import { redirect } from "next/navigation";

function StatCard({ title, value, icon: Icon, color, href }: {
  title: string; value: string | number; icon: React.ElementType; color: string; href: string;
}) {
  return (
    <Link href={href}>
      <Card className="hover:shadow-md transition-shadow cursor-pointer">
        <CardContent className="flex items-center gap-4 p-6">
          <div className={`flex items-center justify-center w-12 h-12 rounded-xl ${color}`}>
            <Icon className="w-6 h-6 text-white" />
          </div>
          <div>
            <p className="text-sm text-muted-foreground">{title}</p>
            <p className="text-2xl font-bold">{value}</p>
          </div>
        </CardContent>
      </Card>
    </Link>
  );
}

export default async function DashboardPage() {
  const supabase = await createClient();
  const user = (await getViewer())?.user;

  // Guarded rather than asserted. `user!.id` below relied on the layout (and
  // now middleware) having redirected an unauthenticated visitor first — true
  // today, and a non-null assertion that outlives whichever of them is
  // refactored. This is the same check the layout makes, stated where the value
  // is actually used.
  if (!user) redirect("/login");

  // Today as a [Melbourne midnight, next Melbourne midnight) window, so the
  // database returns only today's jobs instead of every open scheduled job
  // for JS to filter. Same set isTodayInBusinessTZ used to pick (DST changes
  // happen at 2-3am, never at midnight, so both ends are real instants).
  const todayKey = dateKeyInBusinessTZ(new Date());
  const todayStart = fromBusinessInputValue(`${todayKey}T00:00`);
  const tomorrowStart = fromBusinessInputValue(`${shiftDateKey(todayKey, 1)}T00:00`);

  const [
    { count: totalJobs },
    { count: activeJobs },
    { count: totalCustomers },
    { count: overdueInvoices },
    { data: recentJobs },
    { data: profile },
    { data: scheduledJobs },
    { data: backflowDevices },
  ] = await Promise.all([
    supabase.from("jobs").select("*", { count: "exact", head: true }),
    supabase.from("jobs").select("*", { count: "exact", head: true }).in("status", ["pending", "scheduled", "in_progress"]),
    supabase.from("customers").select("*", { count: "exact", head: true }).eq("is_active", true),
    supabase.from("invoices").select("*", { count: "exact", head: true }).eq("status", "overdue"),
    supabase.from("jobs")
      // jobs has 3 FK columns to profiles (assigned_to, created_by,
      // overtime_logged_by, voice_report_recorded_by), so an unhinted
      // "profiles(...)" embed is ambiguous and PostgREST rejects the whole
      // query (PGRST201) — the query silently returned no rows at all as a
      // result. Naming the alias "assigned_profile" (rather than
      // "assigned_to", which would collide with the raw uuid column)
      // and hinting the exact FK fixes both the failure and the collision.
      .select("id, job_number, title, status, priority, customers(name), assigned_profile:profiles!jobs_assigned_to_fkey(full_name)")
      .order("created_at", { ascending: false })
      .limit(8),
    supabase.from("profiles").select("full_name").eq("id", user.id).single(),
    supabase.from("jobs")
      .select("id, job_number, title, status, scheduled_start, scheduled_end, customers(name), profiles!jobs_assigned_to_fkey(full_name)")
      .gte("scheduled_start", todayStart)
      .lt("scheduled_start", tomorrowStart)
      // Exclude only completed/cancelled (matching "My Jobs" and the Team
      // Schedule) instead of allow-listing specific statuses, so an on_hold
      // job scheduled for today still shows up here.
      .not("status", "in", '("completed","cancelled")')
      .order("scheduled_start"),
    // Due status only needs each device's latest PASSING test, so the embed
    // is filtered and limited to that one row in the database rather than
    // shipping every test ever recorded. Not an inner join: a device with no
    // pass still comes back (empty array) and stays "no_test", as before.
    supabase.from("backflow_devices")
      .select("test_frequency_months, backflow_tests(test_date)")
      .eq("is_active", true)
      .eq("backflow_tests.result", "pass")
      .order("test_date", { referencedTable: "backflow_tests", ascending: false })
      .limit(1, { referencedTable: "backflow_tests" }),
  ]);

  const todaysJobs = scheduledJobs ?? [];

  const backflowDueCount = (backflowDevices ?? []).filter((device: any) => {
    const lastPass = (device.backflow_tests ?? [])[0];
    const nextDueDate = computeNextDueDate(lastPass?.test_date, Number(device.test_frequency_months));
    const status = getDueStatus(nextDueDate);
    return status === "overdue" || status === "due_soon";
  }).length;

  const { hour } = businessDateParts();
  const greeting = hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
  const firstName = profile?.full_name?.split(" ")[0] ?? "there";

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-slate-900">{greeting}, {firstName}</h1>
        <p className="text-slate-500 text-sm mt-1">{formatDate(new Date(), { weekday: "long", day: "numeric", month: "long", year: "numeric" })}</p>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        <StatCard title="Active Jobs" value={activeJobs ?? 0} icon={Briefcase} color="bg-blue-500" href="/dashboard/jobs" />
        <StatCard title="Total Jobs" value={totalJobs ?? 0} icon={CheckCircle2} color="bg-green-500" href="/dashboard/jobs" />
        <StatCard title="Customers" value={totalCustomers ?? 0} icon={Users} color="bg-violet-500" href="/dashboard/customers" />
        <StatCard title="Overdue Invoices" value={overdueInvoices ?? 0} icon={AlertCircle} color="bg-red-500" href="/dashboard/invoices" />
        <StatCard title="Backflow Tests Due" value={backflowDueCount} icon={Droplets} color="bg-cyan-600" href="/dashboard/backflow" />
      </div>

      {/* Today's Jobs */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between pb-3">
          <CardTitle className="text-base font-semibold">Today&rsquo;s Jobs</CardTitle>
          <Link href="/dashboard/schedule" className="text-sm text-blue-600 hover:underline font-medium">View schedule</Link>
        </CardHeader>
        <CardContent className="p-0">
          {todaysJobs.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-10 text-slate-400">
              <Clock className="w-10 h-10 mb-3 opacity-40" />
              <p className="text-sm">No jobs scheduled for today.</p>
            </div>
          ) : (
            <div className="divide-y">
              {todaysJobs.map((job: any) => (
                <Link key={job.id} href={`/dashboard/jobs/${job.id}`} className="flex items-center gap-4 px-6 py-4 hover:bg-slate-50 transition-colors group">
                  <div className="text-center w-16 flex-shrink-0">
                    <p className="text-xs font-bold text-blue-600">{formatTime(job.scheduled_start)}</p>
                    {job.scheduled_end && <p className="text-xs text-slate-400">{formatTime(job.scheduled_end)}</p>}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="font-medium text-sm text-slate-900 group-hover:text-blue-600 transition-colors truncate">
                      #{job.job_number} — {job.title}
                    </p>
                    <p className="text-xs text-slate-500 mt-0.5 truncate">
                      {job.customers?.name}
                      {job.profiles?.full_name ? ` · ${job.profiles.full_name}` : " · Unassigned"}
                    </p>
                  </div>
                  <span className={`text-xs px-2 py-0.5 rounded-full font-medium capitalize flex-shrink-0 ${jobStatusColors[job.status] ?? ""}`}>
                    {job.status.replace("_", " ")}
                  </span>
                </Link>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Recent Jobs */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between pb-3">
          <CardTitle className="text-base font-semibold">Recent Jobs</CardTitle>
          <Link href="/dashboard/jobs" className="text-sm text-blue-600 hover:underline font-medium">View all</Link>
        </CardHeader>
        <CardContent className="p-0">
          {!recentJobs || recentJobs.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-slate-400">
              <Briefcase className="w-10 h-10 mb-3 opacity-40" />
              <p className="text-sm">No jobs yet.</p>
              <Link href="/dashboard/jobs/new" className="mt-2 text-sm text-blue-600 hover:underline">Create your first job</Link>
            </div>
          ) : (
            <div className="divide-y">
              {recentJobs.map((job: any) => (
                <Link key={job.id} href={`/dashboard/jobs/${job.id}`} className="flex items-center justify-between px-6 py-4 hover:bg-slate-50 transition-colors group">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-sm text-slate-900 group-hover:text-blue-600 transition-colors truncate">
                        #{job.job_number} — {job.title}
                      </span>
                    </div>
                    <p className="text-xs text-slate-500 mt-0.5 truncate">
                      {job.customers?.name}
                      {job.assigned_profile?.full_name ? ` · ${job.assigned_profile.full_name}` : ""}
                    </p>
                  </div>
                  <div className="flex items-center gap-2 ml-4 flex-shrink-0">
                    <span className={`text-xs px-2 py-0.5 rounded-full font-medium capitalize ${jobPriorityColors[job.priority] ?? ""}`}>
                      {job.priority}
                    </span>
                    <span className={`text-xs px-2 py-0.5 rounded-full font-medium capitalize ${jobStatusColors[job.status] ?? ""}`}>
                      {job.status.replace("_", " ")}
                    </span>
                  </div>
                </Link>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
