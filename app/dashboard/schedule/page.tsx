import { createClient } from "@/lib/supabase/server";
import { Button } from "@/components/ui/button";
import { Plus } from "lucide-react";
import Link from "next/link";
import { TeamScheduleView } from "@/components/schedule/team-schedule-view";
import { isTodayInBusinessTZ, BUSINESS_TIME_ZONE } from "@/lib/date";

export default async function SchedulePage() {
  const supabase = await createClient();
  const [{ data: jobs }, { data: staff }] = await Promise.all([
    supabase
      .from("jobs")
      .select("*, customers(name), profiles(full_name), sites(name, address_line1, suburb, state, site_lat, site_lng)")
      .not("scheduled_start", "is", null)
      // Match "My Jobs"' status filter (exclude completed/cancelled only,
      // rather than allow-listing specific statuses) so a job on_hold still
      // shows here — otherwise a technician's own "My Jobs" list could show
      // a job as assigned to them while the Team Schedule showed them free,
      // since on_hold wasn't in the old allow-list.
      .not("status", "in", '("completed","cancelled")')
      .order("scheduled_start"),
    supabase
      .from("profiles")
      .select("id, full_name, role")
      .eq("is_active", true)
      .order("full_name"),
  ]);

  const today = new Date();

  const todayJobs = jobs?.filter((j: any) => isTodayInBusinessTZ(j.scheduled_start)) ?? [];
  const upcomingJobs = jobs?.filter((j: any) => !isTodayInBusinessTZ(j.scheduled_start)) ?? [];

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Schedule</h1>
          <p className="text-slate-500 text-sm mt-1">
            {today.toLocaleDateString("en-AU", { weekday: "long", day: "numeric", month: "long", timeZone: BUSINESS_TIME_ZONE })} · {jobs?.length ?? 0} scheduled jobs
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
