import { supabase } from "../../supabase";
import { fromLocalOr, OutsideSyncWindow } from "./source";
import { unwrapRows } from "./unwrap";
import { bool } from "./rowMap";
import { assignedOrCrewSql } from "./assignedJobs";
import type { Booking, BookingWindow } from "../../bookings";

// Job bookings (migration 0079, and 0080 which streams them to devices — both
// DRAFTS, not applied yet): one technician's window and cost centre on a job.
// Pure rules in lib/bookings.ts.
//
// THE THREE STATES THIS MODULE HAS TO TELL APART
//   1. Before 0079 is applied there is no job_bookings table. The remote read
//      answers PGRST205 / 42P01 ("no such table"), and every function here
//      returns NULL — "bookings do not exist yet" — so screens fall back to
//      the job-level schedule instead of showing an error or an empty list.
//   2. 0079 applied, sync streams not yet redeployed (or 0080 not applied):
//      the server has bookings, the device mirror has an empty job_bookings
//      table. An empty local result is then NOT proof of "no bookings". 0079
//      guarantees every scheduled job has at least one booking (its migration
//      asserts it, and every job-level write is translated into bookings), so
//      a scheduled job with none on the device means the mirror cannot answer:
//      the local read throws OutsideSyncWindow and fromLocalOr asks Supabase.
//   3. Everything deployed: local answers, offline included.
// No role gate: every role's stream carries the bookings of the jobs it
// carries (tech_job_bookings / office_job_bookings), and job_bookings is
// readable by every signed-in user (0079 RLS).

/** A booking with the booked person's name, for the job screen and the editor. */
export interface JobBooking extends Booking {
  staff_name: string | null;
}

const COLUMNS = "id, job_id, staff_id, cost_center_id, starts_at, ends_at, daily, all_day";

/**
 * True when PostgREST says the table is not there — 0079 not applied yet.
 * PGRST205 is "not in the schema cache" (current PostgREST); 42P01 is
 * Postgres' undefined_table, which older versions passed through. Matched on
 * the code, never the message.
 */
export function isMissingTable(error: { code?: string } | null | undefined): boolean {
  return !!error && (error.code === "PGRST205" || error.code === "42P01");
}

interface RawBookingRow {
  id: string;
  job_id: string;
  staff_id: string | null;
  cost_center_id: string | null;
  starts_at: string;
  ends_at: string | null;
  daily: boolean | number | null;
  all_day: boolean | number | null;
}

function mapBooking(r: RawBookingRow): Booking {
  return {
    id: r.id,
    job_id: r.job_id,
    staff_id: r.staff_id ?? null,
    cost_center_id: r.cost_center_id ?? null,
    starts_at: r.starts_at,
    ends_at: r.ends_at ?? null,
    daily: bool(r.daily) ?? false,
    all_day: bool(r.all_day) ?? false,
  };
}

// ---------------------------------------------------------------------------
// One job's bookings (job screen header, schedule editor, Time tab clock-in)
// ---------------------------------------------------------------------------

export const SQL_JOB_BOOKINGS = `
  SELECT b.id, b.job_id, b.staff_id, b.cost_center_id, b.starts_at, b.ends_at, b.daily, b.all_day,
         p.full_name AS staff_name
  FROM job_bookings b
  LEFT JOIN profiles p ON p.id = b.staff_id
  WHERE b.job_id = ?
  ORDER BY b.starts_at`;

export const SQL_JOB_SCHEDULE_ON_DEVICE = `SELECT id, scheduled_start FROM jobs WHERE id = ?`;

/**
 * Every booking on a job, earliest first. NULL when bookings do not exist yet
 * (0079 not applied — see the header); the caller shows the job-level
 * schedule instead.
 */
export async function listJobBookings(jobId: string): Promise<JobBooking[] | null> {
  return fromLocalOr<JobBooking[] | null>(
    async (db) => {
      const rows = await db.getAll<RawBookingRow & { staff_name: string | null }>(SQL_JOB_BOOKINGS, [jobId]);
      if (rows.length === 0) {
        const job = await db.getOptional<{ id: string; scheduled_start: string | null }>(SQL_JOB_SCHEDULE_ON_DEVICE, [jobId]);
        // Not on the device (a technician opening someone else's job), or
        // scheduled with no bookings here (state 2) — the mirror cannot say.
        if (!job) throw new OutsideSyncWindow(`job ${jobId} is not on this device`);
        if (job.scheduled_start) throw new OutsideSyncWindow(`job ${jobId} is scheduled but its bookings are not on this device`);
      }
      return rows.map((r) => ({ ...mapBooking(r), staff_name: r.staff_name ?? null }));
    },
    async () => {
      const res = await supabase
        .from("job_bookings")
        .select(`${COLUMNS}, staff:profiles!job_bookings_staff_id_fkey(full_name)`)
        .eq("job_id", jobId)
        .order("starts_at");
      if (isMissingTable(res.error)) return null;
      const rows = unwrapRows(res as never, "listJobBookings") as unknown as (RawBookingRow & {
        staff: { full_name: string } | null;
      })[];
      return rows.map((r) => ({ ...mapBooking(r), staff_name: r.staff?.full_name ?? null }));
    }
  );
}

// ---------------------------------------------------------------------------
// The bookings on a technician's open jobs (My Jobs, the auto-clock's sites)
// ---------------------------------------------------------------------------

// Every booking (anyone's) on the user's open jobs, plus one row per such job
// with no booking at all (b.id NULL) — that row is how the local read spots
// state 2 without a second query. Same "mine, open" scope as SQL_LIST_MY_JOBS.
export const SQL_MY_OPEN_JOB_BOOKINGS = `
  SELECT j.id AS job_id_of_job, j.scheduled_start AS job_scheduled_start,
         b.id, b.job_id, b.staff_id, b.cost_center_id, b.starts_at, b.ends_at, b.daily, b.all_day
  FROM jobs j
  LEFT JOIN job_bookings b ON b.job_id = j.id
  WHERE ${assignedOrCrewSql("j", "?1")}
    AND j.status NOT IN ('completed', 'cancelled')
  ORDER BY b.starts_at`;

type RawMyJobBookingRow = { job_id_of_job: string; job_scheduled_start: string | null } & {
  [K in keyof RawBookingRow]: RawBookingRow[K] | null;
};

/**
 * The bookings on `jobIds` (the list My Jobs or the geofence just loaded for
 * `userId`), everyone's — lib/bookings.ts picks out the user's own. NULL when
 * bookings do not exist yet (0079 not applied).
 *
 * The job list is passed in rather than re-derived so both paths answer for
 * exactly the same jobs: the local SQL finds the user's open jobs itself and
 * is then narrowed to these ids; the remote one asks for these ids.
 */
export async function listMyJobBookings(
  userId: string,
  jobIds: string[]
): Promise<Booking[] | null> {
  const ids = new Set(jobIds);
  return fromLocalOr<Booking[] | null>(
    async (db) => {
      const rows = await db.getAll<RawMyJobBookingRow>(SQL_MY_OPEN_JOB_BOOKINGS, [userId]);
      const onDevice = new Set(rows.map((r) => r.job_id_of_job));
      for (const id of ids) {
        if (!onDevice.has(id)) throw new OutsideSyncWindow(`job ${id} is not on this device`);
      }
      const booked = new Set(rows.filter((r) => r.id).map((r) => r.job_id_of_job));
      for (const r of rows) {
        if (ids.has(r.job_id_of_job) && r.job_scheduled_start && !booked.has(r.job_id_of_job)) {
          throw new OutsideSyncWindow(`job ${r.job_id_of_job} is scheduled but its bookings are not on this device`);
        }
      }
      return rows.filter((r) => r.id && ids.has(r.job_id_of_job)).map((r) => mapBooking(r as RawBookingRow));
    },
    async () => {
      if (ids.size === 0) return [];
      const res = await supabase
        .from("job_bookings")
        .select(COLUMNS)
        .in("job_id", [...ids])
        .order("starts_at");
      if (isMissingTable(res.error)) return null;
      return (unwrapRows(res as never, "listMyJobBookings") as unknown as RawBookingRow[]).map(mapBooking);
    }
  );
}

/**
 * The auto-clock's site list with each site's OWN bookings for `userId`
 * attached (lib/geofenceState.ts TrackedSite.bookings).
 *
 * Best-effort by design: bookings refine the default cost centre, they are
 * not what makes the auto-clock work. A failed or impossible read (offline
 * before the streams are redeployed, or no table yet) returns the sites
 * unchanged, which is exactly the behaviour before bookings existed — never
 * a failed site load, which would switch the auto-clock off.
 */
export async function withMyBookings<S extends { jobId: string }>(
  userId: string,
  sites: S[]
): Promise<(S & { bookings?: BookingWindow[] })[]> {
  if (sites.length === 0) return sites;
  let bookings: Booking[] | null;
  try {
    bookings = await listMyJobBookings(
      userId,
      sites.map((s) => s.jobId)
    );
  } catch (e) {
    console.warn("[geofence] bookings unavailable; clock-ins use the job's cost centre:", e);
    return sites;
  }
  if (!bookings) return sites;
  return sites.map((s) => ({
    ...s,
    bookings: bookings!
      .filter((b) => b.job_id === s.jobId && b.staff_id === userId)
      .map((b) => ({ starts_at: b.starts_at, ends_at: b.ends_at, daily: b.daily, cost_center_id: b.cost_center_id })),
  }));
}

// ---------------------------------------------------------------------------
// The office Schedule tab (network, like the rest of that screen)
// ---------------------------------------------------------------------------

/**
 * Every booking on open jobs, with the booked person's name. Supabase-only,
 * matching the Schedule tab's own job read beside it. NULL before 0079 is
 * applied — the tab then lists one row per job, as it always has.
 */
export async function listOpenJobBookingsRemote(): Promise<JobBooking[] | null> {
  const res = await supabase
    .from("job_bookings")
    .select(`${COLUMNS}, staff:profiles!job_bookings_staff_id_fkey(full_name), jobs!inner(status)`)
    .not("jobs.status", "in", '("completed","cancelled")')
    .order("starts_at");
  if (isMissingTable(res.error)) return null;
  const rows = unwrapRows(res as never, "listOpenJobBookingsRemote") as unknown as (RawBookingRow & {
    staff: { full_name: string } | null;
  })[];
  return rows.map((r) => ({ ...mapBooking(r), staff_name: r.staff?.full_name ?? null }));
}
