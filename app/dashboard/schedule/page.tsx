import { createClient } from "@/lib/supabase/server";
import { Button } from "@/components/ui/button";
import { Plus } from "lucide-react";
import Link from "next/link";
import { TeamScheduleView } from "@/components/schedule/team-schedule-view";

export default async function SchedulePage() {
  const supabase = await createClient();
  const [{ data: jobs }, { data: staff }] = await Promise.all([
    supabase
      .from("jobs")
      .select("*, customers(name), profiles(full_name), sites(name, address_line1, suburb, state, site_lat, site_lng)")
      .not("scheduled_start", "is", null)
      .in("status", ["scheduled", "in_progress", "pending"])
      .order("scheduled_start"),
    supabase
      .from("profiles")
      .select("id, full_name, role")
      .eq("is_active", true)
      .order("full_name"),
  ]);

  const today = new Date();
  const todayStr = today.toDateString();

  const todayJobs = jobs?.filter((j: any) => new Date(j.scheduled_start).toDateString() === todayStr) ?? [];
  const upcomingJobs = jobs?.filter((j: any) => new Date(j.scheduled_start).toDateString() !== todayStr) ?? [];

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Schedule</h1>
          <p className="text-slate-500 text-sm mt-1">
            {today.toLocaleDateString("en-AU", { weekday: "long", day: "numeric", month: "long" })} · {jobs?.length ?? 0} scheduled jobs
          </p>
        </div>
        <Link href="/dashboard/jobs/new">
          <Button className="gap-2"><Plus className="w-4 h-4" />Schedule Job</Button>
        </Link>
      </div>

      <TeamScheduleView
        todayJobs={todayJobs}
        upcomingJobs={upcomingJobs}
        staff={staff ?? []}
      />
    </div>
  );
}
