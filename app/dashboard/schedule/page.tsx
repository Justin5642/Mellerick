import { createClient } from "@/lib/supabase/server";
import { Button } from "@/components/ui/button";
import { Plus } from "lucide-react";
import Link from "next/link";
import { TeamScheduleView } from "@/components/schedule/team-schedule-view";
import { BUSINESS_TIME_ZONE } from "@/lib/date";
import type { TodoJob } from "@/components/schedule/todo-list-panel";
import { crewFromRow, type BoardJob } from "@/components/schedule/board-model";
import { allocatedHoursByJob } from "@/lib/todo-list";

const BOARD_COLUMNS =
  "id, job_number, title, status, scheduled_start, scheduled_end, assigned_to, job_assignments(staff_id), customers(name), sites(name, address_line1, suburb, state, site_lat, site_lng)";

type BoardJobRow = Omit<BoardJob, "crew"> & { job_assignments?: { staff_id: string | null }[] | null };

export default async function SchedulePage() {
  const supabase = await createClient();
  // jobs has multiple FK columns to profiles (assigned_to, created_by,
  // overtime_logged_by, voice_report_recorded_by), so the crew is read through
  // job_assignments(staff_id) — its only FK to jobs is job_id, so that embed is
  // unambiguous — and names come from the staff list below.
  //
  // Only the columns TeamScheduleView's BoardJob type reads — "*" shipped every
  // job's descriptions, notes and voice transcripts to draw a card.
  //
  // Deliberately NOT date-windowed: the board's prev/next arrows step to any
  // day or week client-side, and the List tab's "Upcoming" shows every open
  // job, past-dated ones included. A window would silently drop jobs the UI
  // shows — and a multi-day job that started last week is still on today. The
  // set is bounded by open work (completed/cancelled excluded), not by history.
  //
  // The schedule board only makes sense for jobs that actually have a time
  // slot — a job with no scheduled_start hasn't been scheduled yet, so it
  // belongs in the general Jobs list until someone gives it a time.
  //
  // Match "My Jobs"' status filter (exclude completed/cancelled only) so a job
  // on_hold still shows here; otherwise a technician's own list could show a
  // job as theirs while the board showed them free.
  //
  // schedule_daily / schedule_all_day come from the multi-day migration, which
  // is drafted and NOT APPLIED yet. Until it is, PostgREST rejects the whole
  // select with 42703 (undefined column), so the board retries once without
  // them and every job reads as a single-day block — the board's old behaviour.
  const loadBoardJobs = async () => {
    const run = (columns: string) =>
      supabase
        .from("jobs")
        .select(columns)
        .not("scheduled_start", "is", null)
        .not("status", "in", '("completed","cancelled")')
        .order("scheduled_start", { ascending: true, nullsFirst: false });
    const result = await run(`${BOARD_COLUMNS}, schedule_daily, schedule_all_day`);
    return result.error?.code === "42703" ? run(BOARD_COLUMNS) : result;
  };

  const [{ data: jobRows }, { data: staff }, { count: unscheduledCount }, { data: todoRows, error: todoError }] = await Promise.all([
    loadBoardJobs(),
    supabase
      .from("profiles")
      .select("id, full_name, role")
      .eq("is_active", true)
      .order("full_name"),
    // Lightweight count-only query (no rows fetched) just for the "N need
    // scheduling" header hint — those jobs live in the Jobs list, not on
    // this board, so we don't need their full data here.
    supabase
      .from("jobs")
      .select("*", { count: "exact", head: true })
      .is("scheduled_start", null)
      .not("status", "in", '("completed","cancelled")'),
    // The office To-do list: jobs set aside to fill a gap. A trigger takes a
    // job off once it is scheduled, so "listed" is the whole filter. Its own
    // query so a database without the to-do columns yet fails this panel
    // alone (todoError) and the board above still renders.
    supabase
      .from("jobs")
      .select("id, job_number, title, priority, status, todo_listed_at, estimated_hours, customers(name), sites(suburb)")
      .not("todo_listed_at", "is", null)
      .order("todo_listed_at", { ascending: true }),
  ]);

  // The select string is built at runtime (the 42703 fallback), so the client
  // cannot type the rows; this is the shape both column lists return.
  const jobs: BoardJob[] = ((jobRows ?? []) as unknown as BoardJobRow[]).map(({ job_assignments, ...job }) => ({
    ...job,
    crew: crewFromRow(job.assigned_to, job_assignments),
  }));

  // Two follow-up reads, each needing only the batch above and not each
  // other, so they run together.
  //
  // Fallback hours for listed jobs with no estimate: the PO allocation. Read
  // from the money-free purchase_orders_public view (0038) — hours only, so
  // this page never holds a PO value even though office could read one.
  const todoIds = (todoRows ?? []).filter((j) => j.estimated_hours == null).map((j) => j.id);

  // The staff list above is active-only, so a job whose crew includes someone
  // who's since been deactivated would have no row to render into for them on
  // the Team board. Append any such profiles (flagged) so every crew member's
  // jobs always have somewhere to show up.
  const activeStaff = staff ?? [];
  const activeIds = new Set(activeStaff.map((s) => s.id));
  const missingIds = Array.from(new Set(jobs.flatMap((j) => j.crew).filter((id) => !activeIds.has(id))));

  const [poRows, missingProfiles] = await Promise.all([
    todoIds.length > 0
      ? supabase.from("purchase_orders_public").select("job_id, total_hours").in("job_id", todoIds).then(({ data }) => data)
      : null,
    missingIds.length > 0
      ? supabase.from("profiles").select("id, full_name, role").in("id", missingIds).then(({ data }) => data)
      : null,
  ]);

  const poHours = todoIds.length > 0 ? allocatedHoursByJob(poRows ?? []) : new Map<string, number>();
  const todoJobs: TodoJob[] = (todoRows ?? []).map((j) => ({
    id: j.id,
    job_number: j.job_number,
    title: j.title,
    priority: j.priority,
    status: j.status,
    todo_listed_at: j.todo_listed_at as string,
    estimated_hours: j.estimated_hours,
    po_allocated_hours: poHours.get(j.id) ?? null,
    customer_name: j.customers?.name ?? null,
    suburb: j.sites?.suburb ?? null,
  }));

  const today = new Date();

  let staffForDisplay = activeStaff;
  if (missingIds.length > 0) {
    staffForDisplay = [
      ...staffForDisplay,
      ...(missingProfiles ?? []).map((p: any) => ({ ...p, full_name: `${p.full_name} (inactive)` })),
    ];
  }

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Schedule</h1>
          <p className="text-slate-500 text-sm mt-1">
            {today.toLocaleDateString("en-AU", { weekday: "long", day: "numeric", month: "long", timeZone: BUSINESS_TIME_ZONE })} · {jobs.length} scheduled jobs
            {(unscheduledCount ?? 0) > 0 && (
              <>
                {" "}·{" "}
                <Link href="/dashboard/jobs" className="text-blue-600 hover:underline font-medium">
                  {unscheduledCount} need scheduling
                </Link>
              </>
            )}
          </p>
        </div>
        <Link href="/dashboard/jobs/new">
          <Button className="gap-2"><Plus className="w-4 h-4" />Schedule Job</Button>
        </Link>
      </div>

      <TeamScheduleView
        jobs={jobs}
        staff={staffForDisplay}
        todoJobs={todoJobs}
        todoError={todoError?.message ?? null}
      />
    </div>
  );
}
