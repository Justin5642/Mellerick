import { createClient } from "@/lib/supabase/server";
import { Button } from "@/components/ui/button";
import { Plus } from "lucide-react";
import Link from "next/link";
import { TeamScheduleView } from "@/components/schedule/team-schedule-view";
import { BUSINESS_TIME_ZONE } from "@/lib/date";
import type { TodoJob } from "@/components/schedule/todo-list-panel";
import { crewFromRow, type BoardBooking, type BoardJob } from "@/components/schedule/board-model";
import { allocatedHoursByJob } from "@/lib/todo-list";
import { BOOKING_COLUMNS, bookingsFromJobWindow, isBookingsTableMissing, type JobBooking } from "@/lib/bookings";

const BOARD_COLUMNS =
  "id, job_number, title, status, scheduled_start, scheduled_end, scheduled_cost_center_id, assigned_to, job_assignments(staff_id), customers(name), sites(name, address_line1, suburb, state, site_lat, site_lng)";

type BoardJobRow = Omit<BoardJob, "crew"> & {
  job_assignments?: { staff_id: string | null }[] | null;
  job_bookings?: JobBooking[] | null;
};

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
  // The cards are BOOKINGS (job_bookings, embedded per job — its one FK to
  // jobs makes the embed unambiguous). job_bookings comes from 0079, which is
  // a DRAFT and NOT APPLIED yet; until it is, PostgREST rejects the embed
  // (isBookingsTableMissing) and the board retries without it, drawing each
  // job's one window under every crew member as it did before bookings, and
  // refusing drags (there is no booking row to move).
  //
  // schedule_daily / schedule_all_day (0071, applied) keep their own 42703
  // retry from when they were new: on a database without them every job reads
  // as a single-day block.
  //
  // A scheduled job always has a booking once bookings exist — the derived
  // scheduled_start is set from them — so the filter below still picks
  // exactly the jobs that have something to draw.
  const loadBoardJobs = async () => {
    const run = (columns: string) =>
      supabase
        .from("jobs")
        .select(columns)
        .not("scheduled_start", "is", null)
        .not("status", "in", '("completed","cancelled")')
        .order("scheduled_start", { ascending: true, nullsFirst: false });
    const withBookings = await run(`${BOARD_COLUMNS}, schedule_daily, schedule_all_day, job_bookings(${BOOKING_COLUMNS})`);
    if (!isBookingsTableMissing(withBookings.error) && withBookings.error?.code !== "42703") {
      return { ...withBookings, hasBookings: true };
    }
    const result = await run(`${BOARD_COLUMNS}, schedule_daily, schedule_all_day`);
    return { ...(result.error?.code === "42703" ? await run(BOARD_COLUMNS) : result), hasBookings: false };
  };

  const [{ data: jobRows, hasBookings }, { data: staff }, { count: unscheduledCount }, { data: todoRows, error: todoError }] = await Promise.all([
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

  // The select string is built at runtime (the fallbacks), so the client
  // cannot type the rows; this is the shape every column list returns.
  const rows = (jobRows ?? []) as unknown as BoardJobRow[];
  const jobs: BoardJob[] = rows.map((row) => {
    const { job_assignments, ...job } = row;
    delete job.job_bookings; // drawn from rawBookings below, not carried on the job
    return { ...job, crew: crewFromRow(job.assigned_to, job_assignments) };
  });
  const rawBookings: JobBooking[] = hasBookings
    ? rows.flatMap((r) => r.job_bookings ?? [])
    : jobs.flatMap((j) => bookingsFromJobWindow(j, j.crew));

  // Two follow-up reads, each needing only the batch above and not each
  // other, so they run together.
  //
  // Fallback hours for listed jobs with no estimate: the PO allocation. Read
  // from the money-free purchase_orders_public view (0038) — hours only, so
  // this page never holds a PO value even though office could read one.
  const todoIds = (todoRows ?? []).filter((j) => j.estimated_hours == null).map((j) => j.id);

  // The staff list above is active-only, so a booking for someone who's
  // since been deactivated would have no row to render into on the Team
  // board. Append any such profiles (flagged) so every booking always has
  // somewhere to show up.
  const activeStaff = staff ?? [];
  const activeIds = new Set(activeStaff.map((s) => s.id));
  const missingIds = Array.from(
    new Set(rawBookings.map((b) => b.staff_id).filter((id): id is string => !!id && !activeIds.has(id))),
  );
  // Each card names its cost centre. From the money-free view (0038): this
  // page is open to technicians, who cannot read po_cost_centers itself.
  const costCenterIds = Array.from(new Set(rawBookings.map((b) => b.cost_center_id).filter((id): id is string => !!id)));

  const [poRows, missingProfiles, costCenterRows] = await Promise.all([
    todoIds.length > 0
      ? supabase.from("purchase_orders_public").select("job_id, total_hours").in("job_id", todoIds).then(({ data }) => data)
      : null,
    missingIds.length > 0
      ? supabase.from("profiles").select("id, full_name, role").in("id", missingIds).then(({ data }) => data)
      : null,
    costCenterIds.length > 0
      ? supabase.from("po_cost_centers_public").select("id, name").in("id", costCenterIds).then(({ data }) => data)
      : null,
  ]);
  const costCenterNames = new Map((costCenterRows ?? []).map((cc) => [cc.id, cc.name]));
  const bookings: BoardBooking[] = rawBookings.map((b) => ({
    ...b,
    cost_center_name: b.cost_center_id ? costCenterNames.get(b.cost_center_id) ?? null : null,
  }));

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
        bookings={bookings}
        bookingsReadOnly={!hasBookings}
        staff={staffForDisplay}
        todoJobs={todoJobs}
        todoError={todoError?.message ?? null}
      />
    </div>
  );
}
