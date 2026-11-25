import { createClient } from "@/lib/supabase/server";
import { Button } from "@/components/ui/button";
import { Plus } from "lucide-react";
import Link from "next/link";
import { TeamScheduleView } from "@/components/schedule/team-schedule-view";
import { BUSINESS_TIME_ZONE } from "@/lib/date";
import type { TodoJob } from "@/components/schedule/todo-list-panel";
import { crewFromRow, type BoardBooking, type BoardJob } from "@/components/schedule/board-model";
import { allocatedHoursByJob } from "@/lib/todo-list";
import {
  BOOKING_COLUMNS,
  BOOKING_NOTE_COLUMN,
  bookingsFromJobWindow,
  isBookingsTableMissing,
  isMissingNoteColumn,
  type JobBooking,
} from "@/lib/bookings";
import { getViewer } from "@/lib/auth/viewer";
import { boardLeaveRange, loadScheduleLeave } from "@/lib/staff-leave-data";
import { fetchAllRows, type RangeableQuery } from "@/lib/fetch-all-rows";
import { businessDayRange } from "@/lib/scheduling";
import { loadJobHours, OVER_HOURS_CHUNK, type OverHoursClient } from "@/lib/over-hours-data";
import { boardTextForViewer } from "@/lib/schedule-hover";

const BOARD_COLUMNS =
  // priority, description, customers.company and the site's full address +
  // notes feed the hover card (25 Nov 2026; lib/schedule-hover.ts) — no money.
  "id, job_number, title, status, priority, description, scheduled_start, scheduled_end, scheduled_cost_center_id, assigned_to, job_assignments(staff_id), customers(name, company), sites(name, address_line1, address_line2, suburb, state, postcode, notes, site_lat, site_lng)";

// The select string is built at runtime (the fallbacks), so the typed client
// can't follow it; this is the part of the builder the board's reads use.
type JobsQuery = RangeableQuery<unknown> & {
  not: (column: string, operator: string, value: unknown) => JobsQuery;
  eq: (column: string, value: string) => JobsQuery;
  lt: (column: string, value: string) => JobsQuery;
  or: (filters: string) => JobsQuery;
  order: (column: string, opts?: { ascending?: boolean; nullsFirst?: boolean }) => JobsQuery;
};

/** ISO without milliseconds, for a PostgREST or() filter value (as the phone's schedule). */
function filterIso(iso: string): string {
  return iso.replace(/\.\d{3}Z$/, "Z");
}

function chunkIds(ids: string[], size = OVER_HOURS_CHUNK): string[][] {
  const out: string[][] = [];
  for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size));
  return out;
}

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
  //
  // COMPLETED jobs are drawn too (Justin, 24 Nov 2026: "the same as the
  // mobile so it's visible when jobs have been completed"), greyed and
  // read-only, as the phone's office Schedule tab does: those whose window
  // touches the board's dates (the leave range — 60 days back to 300 ahead).
  // Cancelled jobs never show.
  //
  // Every read is PAGED (lib/fetch-all-rows.ts): PostgREST answers at most
  // 1000 rows per request without saying so, so past 1000 scheduled jobs the
  // board silently lost some — and different ones from the phone. Ordered by
  // scheduled_start then id so pages never overlap or skip.
  const leaveRange = boardLeaveRange();
  const doneFrom = filterIso(businessDayRange(leaveRange.from).dayStartIso);
  const doneTo = filterIso(businessDayRange(leaveRange.to).dayEndIso);
  const loadBoardJobs = async (filter: (q: JobsQuery) => JobsQuery) => {
    const run = async (columns: string) => {
      const res = await fetchAllRows<unknown>((count) =>
        filter(supabase.from("jobs").select(columns, count) as unknown as JobsQuery)
          .order("scheduled_start", { ascending: true, nullsFirst: false })
          .order("id"),
      );
      return res.ok ? { data: res.rows, error: null } : { data: null, error: { message: res.error, code: res.code } };
    };
    // Each booking's scheduling note (0109) rides along; on a database without
    // that column the embed is retried without it before anything else falls back.
    let withBookings = await run(`${BOARD_COLUMNS}, schedule_daily, schedule_all_day, job_bookings(${BOOKING_COLUMNS}, ${BOOKING_NOTE_COLUMN})`);
    if (isMissingNoteColumn(withBookings.error)) {
      withBookings = await run(`${BOARD_COLUMNS}, schedule_daily, schedule_all_day, job_bookings(${BOOKING_COLUMNS})`);
    }
    if (!isBookingsTableMissing(withBookings.error) && withBookings.error?.code !== "42703") {
      return { ...withBookings, hasBookings: true };
    }
    const result = await run(`${BOARD_COLUMNS}, schedule_daily, schedule_all_day`);
    return { ...(result.error?.code === "42703" ? await run(BOARD_COLUMNS) : result), hasBookings: false };
  };
  const openJobsFilter = (q: JobsQuery) =>
    q.not("scheduled_start", "is", null).not("status", "in", '("completed","cancelled")');
  const doneJobsFilter = (q: JobsQuery) =>
    q
      .eq("status", "completed")
      .not("scheduled_start", "is", null)
      .lt("scheduled_start", doneTo)
      .or(`scheduled_end.gte.${doneFrom},and(scheduled_end.is.null,scheduled_start.gte.${doneFrom})`);

  // Staff leave (0112 — a draft, not applied yet's schedule_leave(): the type only for whoever the
  // setting allows — a technician gets "Unavailable"). [] before 0112.
  const [{ data: jobRows, hasBookings }, { data: doneRows, hasBookings: doneHasBookings, error: doneError }, { data: staff }, { count: unscheduledCount }, { data: todoRows, error: todoError }, leave, viewer] = await Promise.all([
    loadBoardJobs(openJobsFilter),
    loadBoardJobs(doneJobsFilter),
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
    loadScheduleLeave(supabase, leaveRange.from, leaveRange.to),
    getViewer(),
  ]);

  // The select string is built at runtime (the fallbacks), so the client
  // cannot type the rows; this is the shape every column list returns.
  // Completed jobs are best-effort: a failed read leaves them off (the open
  // jobs are what the office acts on) rather than taking the board down.
  if (doneError) console.error("[schedule] completed jobs unavailable:", doneError.message);
  const toBoard = (list: unknown[] | null, withBookings: boolean, skip: Set<string>) => {
    const rows = ((list ?? []) as BoardJobRow[]).filter((r) => !skip.has(r.id));
    const jobs: BoardJob[] = rows.map((row) => {
      const { job_assignments, ...job } = row;
      delete job.job_bookings; // drawn from rawBookings below, not carried on the job
      return { ...job, crew: crewFromRow(job.assigned_to, job_assignments) };
    });
    const bookings: JobBooking[] = withBookings
      ? rows.flatMap((r) => r.job_bookings ?? [])
      : jobs.flatMap((j) => bookingsFromJobWindow(j, j.crew));
    return { jobs, bookings };
  };
  const open = toBoard(jobRows, hasBookings, new Set());
  const done = toBoard(doneRows, doneHasBookings, new Set(open.jobs.map((j) => j.id)));
  // The description and site notes are trimmed, and a technician gets them
  // only for jobs they're on (lib/schedule-hover.ts boardTextForViewer).
  const textViewer = { role: viewer?.profile?.role ?? null, id: viewer?.user?.id ?? null };
  const jobs: BoardJob[] = [...open.jobs, ...done.jobs].map((j) => boardTextForViewer(j, textViewer));
  const rawBookings: JobBooking[] = [...open.bookings, ...done.bookings];

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

  // "Over allowed hours" (24 Nov 2026) — office/admin only; technicians see
  // the board as before. Read as the viewer (RLS), hours only; null = the read
  // failed and the board shows no badges.
  const viewerRole = viewer?.profile?.role ?? null;
  const canSeeOverHours = viewerRole === "office" || viewerRole === "admin";

  const [poRows, missingProfiles, costCenterRows, overHours] = await Promise.all([
    todoIds.length > 0
      ? supabase.from("purchase_orders_public").select("job_id, total_hours").in("job_id", todoIds).then(({ data }) => data)
      : null,
    missingIds.length > 0
      ? supabase.from("profiles").select("id, full_name, role").in("id", missingIds).then(({ data }) => data)
      : null,
    costCenterIds.length > 0
      ? // Chunked: completed jobs' bookings add many ids, and a long .in() list
        // outgrows the request URL.
        Promise.all(
          chunkIds(costCenterIds).map((part) =>
            supabase.from("po_cost_centers_public").select("id, name").in("id", part).then(({ data }) => data ?? []),
          ),
        ).then((parts) => parts.flat())
      : null,
    canSeeOverHours ? loadJobHours(supabase as unknown as OverHoursClient, jobs.map((j) => j.id)) : null,
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
            {today.toLocaleDateString("en-AU", { weekday: "long", day: "numeric", month: "long", timeZone: BUSINESS_TIME_ZONE })} · {open.jobs.length} scheduled jobs
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
        {/* A NEW job. An existing one is booked from the board's own
            "Schedule" button (type the job, click a technician's day). */}
        <Link href="/dashboard/jobs/new">
          <Button variant="outline" className="gap-2"><Plus className="w-4 h-4" />New Job</Button>
        </Link>
      </div>

      <TeamScheduleView
        jobs={jobs}
        bookings={bookings}
        bookingsReadOnly={!hasBookings}
        staff={staffForDisplay}
        todoJobs={todoJobs}
        todoError={todoError?.message ?? null}
        leave={leave}
        viewerRole={viewerRole}
        overHours={overHours}
        viewerId={viewer?.user?.id ?? null}
      />
    </div>
  );
}
