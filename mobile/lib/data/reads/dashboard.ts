import { supabase } from "../../supabase";
import { fromLocalOr, type LocalReads } from "./source";
import { bool, nestOne, num } from "./rowMap";
import { unwrapCount, unwrapRows } from "./unwrap";

// The office dashboard (app/(office)/dashboard.tsx): four stat counts, the
// eight most recent jobs, and every open scheduled job (the screen narrows that
// to today in the business timezone). Backflow due-counts come from
// listBackflowDevices (reads/backflow.ts), which is already local-first.
//
// OFFICE/ADMIN ONLY, and the gate is load-bearing: the counts are statements
// about the WHOLE business ("Active Jobs", "Overdue Invoices"). Only the
// office/admin mirror carries the whole jobs/invoices tables; a technician's
// would hold just their own jobs and no invoices, so a local answer would be a
// silently wrong number. The route is office-only anyway; this keeps the read
// honest if it is ever reused.
//
// Local and remote return the IDENTICAL shape (dashboard.local.test.ts). The
// remote path used to `select("*")` on jobs and alias the assignee differently
// in its two job queries; both now name the columns the screen renders and use
// one alias, `assigned_profile`.

export interface DashboardJob {
  id: string;
  job_number: number;
  title: string;
  status: string;
  priority: string | null;
  scheduled_start: string | null;
  scheduled_end: string | null;
  /** Migration 0071 — the screen asks occupiesDay(), never the start date alone. */
  schedule_daily: boolean;
  customers: { name: string } | null;
  assigned_profile: { full_name: string } | null;
}

export interface DashboardCounts {
  total: number;
  active: number;
  customers: number;
  overdue: number;
}

export interface OfficeDashboard {
  counts: DashboardCounts;
  recent: DashboardJob[];
  /** Open jobs with a scheduled start, earliest first (all dates — the screen keeps those occupying today). */
  scheduled: DashboardJob[];
}

const ACTIVE_STATUSES = ["pending", "scheduled", "in_progress"];

// Columns are alias-qualified so sqlLint.test.ts can attribute them across the
// four subqueries (bare columns in a multi-table statement go unchecked).
export const SQL_DASHBOARD_COUNTS = `
  SELECT
    (SELECT COUNT(*) FROM jobs) AS total,
    (SELECT COUNT(*) FROM jobs j WHERE j.status IN ('pending', 'scheduled', 'in_progress')) AS active,
    (SELECT COUNT(*) FROM customers c WHERE c.is_active = 1) AS customers,
    (SELECT COUNT(*) FROM invoices i WHERE i.status = 'overdue') AS overdue`;

export const SQL_DASHBOARD_RECENT_JOBS = `
  SELECT j.id, j.job_number, j.title, j.status, j.priority, j.scheduled_start, j.scheduled_end, j.schedule_daily,
         c.name AS customer_name, p.full_name AS assigned_full_name
  FROM jobs j
  LEFT JOIN customers c ON c.id = j.customer_id
  LEFT JOIN profiles  p ON p.id = j.assigned_to
  ORDER BY j.created_at DESC
  LIMIT 8`;

export const SQL_DASHBOARD_SCHEDULED_JOBS = `
  SELECT j.id, j.job_number, j.title, j.status, j.priority, j.scheduled_start, j.scheduled_end, j.schedule_daily,
         c.name AS customer_name, p.full_name AS assigned_full_name
  FROM jobs j
  LEFT JOIN customers c ON c.id = j.customer_id
  LEFT JOIN profiles  p ON p.id = j.assigned_to
  WHERE j.scheduled_start IS NOT NULL
    AND j.status NOT IN ('completed', 'cancelled')
  ORDER BY j.scheduled_start`;

interface RawDashJobRow {
  id: string;
  job_number: number | string;
  title: string;
  status: string;
  priority: string | null;
  scheduled_start: string | null;
  scheduled_end: string | null;
  schedule_daily: number | boolean | null;
  customer_name: string | null;
  assigned_full_name: string | null;
}

interface RawCountsRow {
  total: number | string | null;
  active: number | string | null;
  customers: number | string | null;
  overdue: number | string | null;
}

function mapDashJob(r: RawDashJobRow): DashboardJob {
  return {
    id: r.id,
    job_number: num(r.job_number),
    title: r.title,
    status: r.status,
    priority: r.priority ?? null,
    scheduled_start: r.scheduled_start ?? null,
    scheduled_end: r.scheduled_end ?? null,
    schedule_daily: bool(r.schedule_daily) ?? false,
    // customers.name / profiles.full_name: a null alias means a null FK, which
    // is when PostgREST returns a null embed.
    customers: nestOne(r.customer_name, { name: r.customer_name as string }),
    assigned_profile: nestOne(r.assigned_full_name, { full_name: r.assigned_full_name as string }),
  };
}

/** PostgREST row → the flat Raw shape, so ONE mapper serves both paths. */
interface RemoteDashJobRow extends Omit<RawDashJobRow, "customer_name" | "assigned_full_name"> {
  customers: { name: string } | null;
  assigned_profile: { full_name: string | null } | null;
}
const flattenRemote = ({ customers, assigned_profile, ...j }: RemoteDashJobRow): RawDashJobRow => ({
  ...j,
  customer_name: customers?.name ?? null,
  assigned_full_name: assigned_profile?.full_name ?? null,
});

// jobs has multiple FKs to profiles — the FK hint + alias are required.
const JOB_COLUMNS =
  "id, job_number, title, status, priority, scheduled_start, scheduled_end, schedule_daily, customers(name), assigned_profile:profiles!jobs_assigned_to_fkey(full_name)";

async function getOfficeDashboardLocal(db: LocalReads): Promise<OfficeDashboard> {
  const counts = await db.getOptional<RawCountsRow>(SQL_DASHBOARD_COUNTS);
  const recent = await db.getAll<RawDashJobRow>(SQL_DASHBOARD_RECENT_JOBS);
  const scheduled = await db.getAll<RawDashJobRow>(SQL_DASHBOARD_SCHEDULED_JOBS);
  return {
    counts: {
      total: num(counts?.total),
      active: num(counts?.active),
      customers: num(counts?.customers),
      overdue: num(counts?.overdue),
    },
    recent: recent.map(mapDashJob),
    scheduled: scheduled.map(mapDashJob),
  };
}

// ---------------------------------------------------------------------------
// "Needs a look from yesterday" — clocks still running (Stage 5, as the web
// dashboard, app/dashboard/page.tsx). Every open WORK entry, oldest first; the
// screen keeps those clocked on before today (Melbourne) — the departures a
// phone missed (dead battery, app swiped away). Filtering by instant happens
// in JS on both paths: SQLite holds clock_in as text in whatever offset the
// server sent, so a string comparison against "today" could be wrong.
//
// Complete on the office device: an open entry is recent activity, so its job
// and the entry itself are inside the office sync window (0068). Office/admin
// only, like everything on this screen.
// ---------------------------------------------------------------------------

export interface OpenWorkClock {
  id: string;
  clock_in: string;
  job_id: string;
  job_number: number | null;
  job_title: string | null;
  staff_name: string | null;
}

export const SQL_DASHBOARD_OPEN_CLOCKS = `
  SELECT t.id, t.clock_in, t.job_id, j.job_number, j.title AS job_title, p.full_name AS staff_name
  FROM time_entries t
  LEFT JOIN jobs j     ON j.id = t.job_id
  LEFT JOIN profiles p ON p.id = t.staff_id
  WHERE t.clock_out IS NULL AND t.entry_type = 'work'`;

interface RawOpenClockRow {
  id: string;
  clock_in: string;
  job_id: string;
  job_number: number | string | null;
  job_title: string | null;
  staff_name: string | null;
}

const byClockIn = (a: OpenWorkClock, b: OpenWorkClock) => new Date(a.clock_in).getTime() - new Date(b.clock_in).getTime();

export async function listOpenWorkClocks(): Promise<OpenWorkClock[]> {
  return fromLocalOr(
    async (db) =>
      (await db.getAll<RawOpenClockRow>(SQL_DASHBOARD_OPEN_CLOCKS))
        .map((r) => ({
          id: r.id,
          clock_in: r.clock_in,
          job_id: r.job_id,
          job_number: r.job_number == null ? null : num(r.job_number),
          job_title: r.job_title ?? null,
          staff_name: r.staff_name ?? null,
        }))
        .sort(byClockIn),
    async () => {
      const res = await supabase
        .from("time_entries")
        .select("id, clock_in, job_id, jobs!time_entries_job_id_fkey(job_number, title), profiles!time_entries_staff_id_fkey(full_name)")
        .is("clock_out", null)
        .eq("entry_type", "work")
        .order("clock_in");
      type Row = {
        id: string;
        clock_in: string;
        job_id: string;
        jobs: { job_number: number; title: string } | null;
        profiles: { full_name: string | null } | null;
      };
      return (unwrapRows(res as never, "listOpenWorkClocks") as unknown as Row[])
        .map((r) => ({
          id: r.id,
          clock_in: r.clock_in,
          job_id: r.job_id,
          job_number: r.jobs?.job_number ?? null,
          job_title: r.jobs?.title ?? null,
          staff_name: r.profiles?.full_name ?? null,
        }))
        .sort(byClockIn);
    },
    { roles: ["office", "admin"] }
  );
}

export async function getOfficeDashboard(): Promise<OfficeDashboard> {
  return fromLocalOr(
    getOfficeDashboardLocal,
    async () => {
      const [totalRes, activeRes, custRes, overdueRes, recentRes, scheduledRes] = await Promise.all([
        supabase.from("jobs").select("*", { count: "exact", head: true }),
        supabase.from("jobs").select("*", { count: "exact", head: true }).in("status", ACTIVE_STATUSES),
        supabase.from("customers").select("*", { count: "exact", head: true }).eq("is_active", true),
        supabase.from("invoices").select("*", { count: "exact", head: true }).eq("status", "overdue"),
        supabase.from("jobs").select(JOB_COLUMNS).order("created_at", { ascending: false }).limit(8),
        supabase
          .from("jobs")
          .select(JOB_COLUMNS)
          .not("scheduled_start", "is", null)
          .not("status", "in", '("completed","cancelled")')
          .order("scheduled_start"),
      ]);
      return {
        counts: {
          total: unwrapCount(totalRes, "getOfficeDashboard.totalJobs"),
          active: unwrapCount(activeRes, "getOfficeDashboard.activeJobs"),
          customers: unwrapCount(custRes, "getOfficeDashboard.customers"),
          overdue: unwrapCount(overdueRes, "getOfficeDashboard.overdueInvoices"),
        },
        recent: (unwrapRows(recentRes as never, "getOfficeDashboard.recentJobs") as RemoteDashJobRow[]).map((r) =>
          mapDashJob(flattenRemote(r))
        ),
        scheduled: (unwrapRows(scheduledRes as never, "getOfficeDashboard.scheduledJobs") as RemoteDashJobRow[]).map(
          (r) => mapDashJob(flattenRemote(r))
        ),
      };
    },
    { roles: ["office", "admin"] }
  );
}
