import { supabase } from "../../supabase";
import { fromLocalOr, type LocalReads } from "./source";
import { nestOne, num, numOrNull } from "./rowMap";
import { unwrap, unwrapRows } from "./unwrap";
import { assignedOrCrewFilter, assignedOrCrewSql, crewJobIdsRemote } from "./assignedJobs";

// Read-repository layer for the job screens (phase 2 of the PowerSync read
// integration — design §6 step 6). Each exported function owns one screen's
// inline query, moved here verbatim inside the remote() closure so the
// Supabase fallback stays byte-identical to the pre-extraction behaviour.
//
// Role routing (per stream scoping in powersync/sync-streams.yaml):
//   • listMyJobs / listMyJobSites — NO role gate. The tech_jobs stream scopes
//     a technician's mirror through job_assignments (0059); an office/admin
//     mirror has ALL jobs and assignments, and the WHERE narrows it
//     identically. Both are faithful. "Mine" means ANY current assignee, not
//     just jobs.assigned_to's primary — see ./assignedJobs.
//   • getJob — NO role gate, but a local MISS falls back to remote():
//     job/[id] is a shared route, and a technician opening a job NOT
//     assigned to them has no local row — a miss is not proof of absence.
//   • listOfficeJobs / searchOfficeJobs — office/admin only (the (office)
//     group is role-guarded; only those mirrors carry the full jobs table).
//   • searchJobs — office/admin only, even though the screen is currently
//     technician-only: the screen exists to find ANY job in the system, and
//     a technician's mirror holds only their assigned jobs. Serving it
//     locally would silently hide every other job — so technicians are
//     routed to Supabase, which still returns the full set.
//
// KNOWN STREAM GAP (documented, not handled here): tech_jobs does not carry
// overtime_reason / overtime_category, so a technician's LOCAL getJob returns
// them as NULL even for their own job (the hours-scoreboard seeds its "reason
// logged" state from these). Add both columns to the tech_jobs stream before
// pointing the job/[id] screen at getJob, or techs will be re-prompted for
// already-logged overtime reasons while offline.

// ---------------------------------------------------------------------------
// Interfaces — exactly what the screens destructure today.
// ---------------------------------------------------------------------------

/** Site embed shared by the My Jobs and Search screens (identical inline shapes today). */
export interface JobSiteSummary {
  name: string;
  address_line1: string;
  suburb: string;
  site_lat: number | null;
  site_lng: number | null;
}

/** components/jobs/my-jobs-screen.tsx `Job` */
export interface MyJob {
  id: string;
  job_number: number;
  title: string;
  status: string;
  scheduled_start: string | null;
  scheduled_end: string | null;
  customers: { name: string } | null;
  sites: JobSiteSummary | null;
}

/** app/job/[id].tsx `job` (currently `any`; these are the selected columns) */
export interface JobDetail {
  id: string;
  job_number: number;
  title: string;
  status: string;
  priority: string;
  description: string | null;
  notes: string | null;
  job_type: string | null;
  created_at: string;
  scheduled_start: string | null;
  scheduled_end: string | null;
  actual_start: string | null;
  actual_end: string | null;
  completion_notes: string | null;
  overtime_reason: string | null;
  overtime_category: string | null;
  voice_report_transcript: string | null;
  assigned_to: string | null;
  scheduled_cost_center_id: string | null;
  assigned_profile: { full_name: string } | null;
  customers: { name: string; phone: string | null; mobile: string | null; email: string | null } | null;
  sites: {
    name: string;
    address_line1: string;
    suburb: string;
    state: string;
    postcode: string;
    site_lat: number | null;
    site_lng: number | null;
  } | null;
}

/** app/(office)/jobs.tsx `OfficeJob` */
export interface OfficeJob {
  id: string;
  job_number: number;
  title: string;
  status: string;
  priority: string;
  customers: { name: string } | null;
  assigned_profile: { full_name: string } | null;
  // Stage of the most recent job_stage_notes row for this job (null = no
  // stage note logged yet) — "where the last person left off", surfaced as a
  // badge in the office jobs list so office staff can scan job status without
  // opening each job. Distinct from `status` (whole-job lifecycle).
  current_stage: string | null;
}

/** app/(tabs)/search.tsx `Job` */
export interface JobSearchRow {
  id: string;
  job_number: number;
  title: string;
  status: string;
  scheduled_start: string | null;
  customers: { name: string } | null;
  sites: JobSiteSummary | null;
}

const ROLES = { roles: ["office", "admin"] as ("office" | "admin")[] };

// The (office)/jobs.tsx SELECT, shared by its search and pagination queries.
const OFFICE_SELECT =
  "id, job_number, title, status, priority, customers(name), assigned_profile:profiles!jobs_assigned_to_fkey(full_name)";

// Same, plus the latest job_stage_notes row per job. `.order(..., {
// foreignTable})` + `.limit(1, {foreignTable})` below scope to the embedded
// resource, so PostgREST returns at most one (the most recent) stage note per
// job instead of the full history.
const OFFICE_SELECT_WITH_STAGE = `${OFFICE_SELECT}, job_stage_notes(stage, created_at)`;

// ---------------------------------------------------------------------------
// Local SQL (SQLite dialect — design §0/§3 rewrites: embeds → LEFT JOIN +
// nestOne, ilike → LIKE, range → LIMIT/OFFSET, nullable ORDER BY prefixed
// with `IS NULL` for PG NULLS-LAST parity).
// ---------------------------------------------------------------------------

// `.order("scheduled_start", { ascending: true, nullsFirst: false })` is PG
// ASC NULLS LAST; SQLite ASC is NULLS FIRST, hence the `IS NULL,` prefix.
export const SQL_LIST_MY_JOBS = `
  SELECT j.id, j.job_number, j.title, j.status, j.scheduled_start, j.scheduled_end,
         c.name AS customer_name,
         s.name AS site_name, s.address_line1 AS site_address_line1,
         s.suburb AS site_suburb, s.site_lat, s.site_lng
  FROM jobs j
  LEFT JOIN customers c ON c.id = j.customer_id
  LEFT JOIN sites     s ON s.id = j.site_id
  WHERE ${assignedOrCrewSql("j", "?1")}
    AND j.status NOT IN ('completed', 'cancelled')
  ORDER BY j.scheduled_start IS NULL, j.scheduled_start`;

// The geofence's site list: the same "mine, open" scope as My Jobs, cut down to
// what the auto-clock needs. A job without coordinates cannot be geofenced and
// is filtered out in mapJobSites (shared with the remote path), not here, so the
// two paths cannot disagree about what counts as having coordinates. Soonest
// first: the off-hours wake regions keep only the first 20 (lib/trackingGate.ts).
export const SQL_LIST_MY_JOB_SITES = `
  SELECT j.id, j.scheduled_cost_center_id, s.site_lat, s.site_lng
  FROM jobs j
  LEFT JOIN sites s ON s.id = j.site_id
  WHERE ${assignedOrCrewSql("j", "?1")}
    AND j.status NOT IN ('completed', 'cancelled')
  ORDER BY j.scheduled_start IS NULL, j.scheduled_start, j.id`;

export const SQL_GET_JOB = `
  SELECT j.id, j.job_number, j.title, j.status, j.priority, j.description, j.notes,
         j.job_type, j.created_at, j.scheduled_start, j.scheduled_end,
         j.actual_start, j.actual_end, j.completion_notes,
         j.overtime_reason, j.overtime_category, j.voice_report_transcript,
         j.assigned_to, j.scheduled_cost_center_id, p.full_name AS assigned_profile_full_name,
         c.name AS customer_name, c.phone AS customer_phone,
         c.mobile AS customer_mobile, c.email AS customer_email,
         s.name AS site_name, s.address_line1 AS site_address_line1,
         s.suburb AS site_suburb, s.state AS site_state, s.postcode AS site_postcode,
         s.site_lat, s.site_lng
  FROM jobs j
  LEFT JOIN customers c ON c.id = j.customer_id
  LEFT JOIN sites     s ON s.id = j.site_id
  LEFT JOIN profiles  p ON p.id = j.assigned_to
  WHERE j.id = ?`;

// current_stage: a correlated subquery reusing the job_stage_notes_job_id_
// stage_created_at_idx index (0057 migration) to grab just the most recent
// note's stage per job, without pulling the full note history for a list row.
export const SQL_LIST_OFFICE_JOBS = `
  SELECT j.id, j.job_number, j.title, j.status, j.priority,
         c.name AS customer_name,
         p.full_name AS assigned_profile_full_name,
         (SELECT n.stage FROM job_stage_notes n WHERE n.job_id = j.id ORDER BY n.created_at DESC LIMIT 1) AS current_stage
  FROM jobs j
  LEFT JOIN customers c ON c.id = j.customer_id
  LEFT JOIN profiles  p ON p.id = j.assigned_to
  ORDER BY j.created_at DESC, j.id DESC
  LIMIT ? OFFSET ?`;

// ?1 = stripped search text (NULL = no search), ?2 = numeric job number
// (NULL unless the whole query is digits) — mirrors the screen's
// `.or(title.ilike…, job_number.eq…)`. The bare LIMIT ? binds as ?3.
export const SQL_SEARCH_OFFICE_JOBS = `
  SELECT j.id, j.job_number, j.title, j.status, j.priority,
         c.name AS customer_name,
         p.full_name AS assigned_profile_full_name,
         (SELECT n.stage FROM job_stage_notes n WHERE n.job_id = j.id ORDER BY n.created_at DESC LIMIT 1) AS current_stage
  FROM jobs j
  LEFT JOIN customers c ON c.id = j.customer_id
  LEFT JOIN profiles  p ON p.id = j.assigned_to
  WHERE (?1 IS NULL OR j.title LIKE '%'||?1||'%' OR (?2 IS NOT NULL AND j.job_number = ?2))
  ORDER BY j.created_at DESC, j.id DESC
  LIMIT ?`;

// The SQL twin of search.tsx's client-side haystack filter: the same six
// fields, substring semantics (LIKE metacharacters are escaped by the
// caller), first 50 newest-first — matching `.slice(0, 50)` over a
// created_at-DESC list. SQLite LIKE is ASCII-case-insensitive, matching the
// screen's toLowerCase() for ASCII (documented divergence on non-ASCII).
export const SQL_SEARCH_JOBS = `
  SELECT j.id, j.job_number, j.title, j.status, j.scheduled_start,
         c.name AS customer_name,
         s.name AS site_name, s.address_line1 AS site_address_line1,
         s.suburb AS site_suburb, s.site_lat, s.site_lng
  FROM jobs j
  LEFT JOIN customers c ON c.id = j.customer_id
  LEFT JOIN sites     s ON s.id = j.site_id
  WHERE CAST(j.job_number AS TEXT) LIKE '%'||?1||'%' ESCAPE '\\'
     OR j.title LIKE '%'||?1||'%' ESCAPE '\\'
     OR c.name LIKE '%'||?1||'%' ESCAPE '\\'
     OR s.name LIKE '%'||?1||'%' ESCAPE '\\'
     OR s.address_line1 LIKE '%'||?1||'%' ESCAPE '\\'
     OR s.suburb LIKE '%'||?1||'%' ESCAPE '\\'
  ORDER BY j.created_at DESC
  LIMIT 50`;

// ---------------------------------------------------------------------------
// SQLite-shaped rows (booleans would be 1/0; numerics are numbers via the
// declared column types, but num/numOrNull tolerate strings — risk #2).
// ---------------------------------------------------------------------------

interface RawMyJobRow {
  id: string;
  job_number: number | string;
  title: string;
  status: string;
  scheduled_start: string | null;
  scheduled_end: string | null;
  customer_name: string | null;
  site_name: string | null;
  site_address_line1: string | null;
  site_suburb: string | null;
  site_lat: number | string | null;
  site_lng: number | string | null;
}

interface RawJobDetailRow {
  id: string;
  job_number: number | string;
  title: string;
  status: string;
  priority: string;
  description: string | null;
  notes: string | null;
  job_type: string | null;
  created_at: string;
  scheduled_start: string | null;
  scheduled_end: string | null;
  actual_start: string | null;
  actual_end: string | null;
  completion_notes: string | null;
  overtime_reason: string | null;
  overtime_category: string | null;
  voice_report_transcript: string | null;
  assigned_to: string | null;
  scheduled_cost_center_id: string | null;
  assigned_profile_full_name: string | null;
  customer_name: string | null;
  customer_phone: string | null;
  customer_mobile: string | null;
  customer_email: string | null;
  site_name: string | null;
  site_address_line1: string | null;
  site_suburb: string | null;
  site_state: string | null;
  site_postcode: string | null;
  site_lat: number | string | null;
  site_lng: number | string | null;
}

interface RawOfficeJobRow {
  id: string;
  job_number: number | string;
  title: string;
  status: string;
  priority: string;
  customer_name: string | null;
  assigned_profile_full_name: string | null;
  current_stage: string | null;
}

interface RawJobSearchRow {
  id: string;
  job_number: number | string;
  title: string;
  status: string;
  scheduled_start: string | null;
  customer_name: string | null;
  site_name: string | null;
  site_address_line1: string | null;
  site_suburb: string | null;
  site_lat: number | string | null;
  site_lng: number | string | null;
}

// customers.name / sites.name / profiles.full_name are all NOT NULL
// (0000_baseline.sql), so a null join alias can only mean the FK was null or
// the row is absent locally — exactly when the embed should be null, not
// `{ name: null }` (screens test `row.customers?.name`). nestOne keys on it.

function mapSiteSummary(r: {
  site_name: string | null;
  site_address_line1: string | null;
  site_suburb: string | null;
  site_lat: number | string | null;
  site_lng: number | string | null;
}): JobSiteSummary | null {
  return nestOne(r.site_name, {
    name: r.site_name as string,
    address_line1: r.site_address_line1 as string,
    suburb: r.site_suburb as string,
    site_lat: numOrNull(r.site_lat),
    site_lng: numOrNull(r.site_lng),
  });
}

function mapMyJob(r: RawMyJobRow): MyJob {
  return {
    id: r.id,
    job_number: num(r.job_number),
    title: r.title,
    status: r.status,
    scheduled_start: r.scheduled_start,
    scheduled_end: r.scheduled_end,
    customers: nestOne(r.customer_name, { name: r.customer_name as string }),
    sites: mapSiteSummary(r),
  };
}

function mapJobDetail(r: RawJobDetailRow): JobDetail {
  return {
    id: r.id,
    job_number: num(r.job_number),
    title: r.title,
    status: r.status,
    priority: r.priority,
    description: r.description,
    notes: r.notes,
    job_type: r.job_type,
    created_at: r.created_at,
    scheduled_start: r.scheduled_start,
    scheduled_end: r.scheduled_end,
    actual_start: r.actual_start,
    actual_end: r.actual_end,
    completion_notes: r.completion_notes,
    overtime_reason: r.overtime_reason,
    overtime_category: r.overtime_category,
    voice_report_transcript: r.voice_report_transcript,
    assigned_to: r.assigned_to,
    scheduled_cost_center_id: r.scheduled_cost_center_id,
    assigned_profile: nestOne(r.assigned_profile_full_name, { full_name: r.assigned_profile_full_name as string }),
    customers: nestOne(r.customer_name, {
      name: r.customer_name as string,
      phone: r.customer_phone,
      mobile: r.customer_mobile,
      email: r.customer_email,
    }),
    sites: nestOne(r.site_name, {
      name: r.site_name as string,
      address_line1: r.site_address_line1 as string,
      suburb: r.site_suburb as string,
      state: r.site_state as string,
      postcode: r.site_postcode as string,
      site_lat: numOrNull(r.site_lat),
      site_lng: numOrNull(r.site_lng),
    }),
  };
}

function mapJobSearchRow(r: RawJobSearchRow): JobSearchRow {
  return {
    id: r.id,
    job_number: num(r.job_number),
    title: r.title,
    status: r.status,
    scheduled_start: r.scheduled_start,
    customers: nestOne(r.customer_name, { name: r.customer_name as string }),
    sites: mapSiteSummary(r),
  };
}

function mapOfficeJob(r: RawOfficeJobRow): OfficeJob {
  return {
    id: r.id,
    job_number: num(r.job_number),
    title: r.title,
    status: r.status,
    priority: r.priority,
    customers: nestOne(r.customer_name, { name: r.customer_name as string }),
    assigned_profile: nestOne(r.assigned_profile_full_name, {
      full_name: r.assigned_profile_full_name as string,
    }),
    current_stage: r.current_stage ?? null,
  };
}

/** Pulls the stage off a `.limit(1, {foreignTable})`-scoped embed array. */
function currentStageFromEmbed(rows: { stage: string; created_at: string }[] | null | undefined): string | null {
  return rows?.[0]?.stage ?? null;
}

/** Escape LIKE metacharacters so a bound query matches as a plain substring. */
function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (m) => `\\${m}`);
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * The technician "My Jobs" list: open jobs the user is on (any current
 * assignee — see ./assignedJobs), soonest first, unscheduled last. No role
 * gate — every role's mirror answers this faithfully (a technician's contains
 * exactly their jobs; an office/admin mirror contains all jobs and the WHERE
 * narrows identically).
 */
export async function listMyJobs(userId: string): Promise<MyJob[]> {
  return fromLocalOr(
    async (db) => {
      const rows = await db.getAll<RawMyJobRow>(SQL_LIST_MY_JOBS, [userId]);
      return rows.map(mapMyJob);
    },
    // components/jobs/my-jobs-screen.tsx's original loadJobs body, with the
    // assigned_to-only filter widened to the crew (same rule as the SQL above).
    async () => {
      const crew = await crewJobIdsRemote(userId, { kind: "open" }, "listMyJobs");
      const res = await supabase
        .from("jobs")
        .select("id, job_number, title, status, scheduled_start, scheduled_end, customers(name), sites(name, address_line1, suburb, site_lat, site_lng)")
        .or(assignedOrCrewFilter(userId, crew))
        .not("status", "in", '("completed","cancelled")')
        .order("scheduled_start", { ascending: true, nullsFirst: false });
      // The single most dangerous read in the app: a discarded error here
      // renders "No jobs assigned" to a technician standing on site, who then
      // goes home. Failing loudly is the only honest answer.
      return unwrapRows(res as never, "listMyJobs") as unknown as MyJob[];
    }
  );
}

/** One geofence-able job: what the auto-clock draws a circle round. */
export interface MyJobSite {
  jobId: string;
  lat: number;
  lng: number;
  scheduledCostCenterId: string | null;
}

interface RawJobSiteRow {
  id: string;
  scheduled_cost_center_id: string | null;
  site_lat: number | string | null;
  site_lng: number | string | null;
}

// Shared by both paths. Truthiness, not `!= null`, is the rule the geofence has
// always applied: a 0/0 coordinate is an unset pin, not a site in the Atlantic.
function mapJobSites(rows: RawJobSiteRow[]): MyJobSite[] {
  const out: MyJobSite[] = [];
  for (const r of rows) {
    const lat = numOrNull(r.site_lat);
    const lng = numOrNull(r.site_lng);
    if (!lat || !lng) continue;
    out.push({ jobId: r.id, lat, lng, scheduledCostCenterId: r.scheduled_cost_center_id ?? null });
  }
  return out;
}

/**
 * The auto-clock's site list: the user's open jobs (same scope as listMyJobs)
 * that have coordinates.
 *
 * Local-first, unlike the network query it replaces. That query ran every ten
 * minutes all shift, and offline it failed — which kept the previous list (by
 * design) but meant a job assigned while the technician was out of signal could
 * never be geofenced until signal came back, even once PowerSync had it.
 */
export async function listMyJobSites(userId: string): Promise<MyJobSite[]> {
  return fromLocalOr(
    async (db) => mapJobSites(await db.getAll<RawJobSiteRow>(SQL_LIST_MY_JOB_SITES, [userId])),
    async () => {
      const crew = await crewJobIdsRemote(userId, { kind: "open" }, "listMyJobSites");
      const res = await supabase
        .from("jobs")
        .select("id, scheduled_cost_center_id, sites(site_lat, site_lng)")
        .or(assignedOrCrewFilter(userId, crew))
        .not("status", "in", '("completed","cancelled")')
        .order("scheduled_start", { ascending: true, nullsFirst: false })
        .order("id", { ascending: true });
      const rows = unwrapRows(res as never, "listMyJobSites") as unknown as {
        id: string;
        scheduled_cost_center_id: string | null;
        sites: { site_lat: number | null; site_lng: number | null } | null;
      }[];
      return mapJobSites(
        rows.map((r) => ({
          id: r.id,
          scheduled_cost_center_id: r.scheduled_cost_center_id,
          site_lat: r.sites?.site_lat ?? null,
          site_lng: r.sites?.site_lng ?? null,
        }))
      );
    }
  );
}

/**
 * Single job with customer/site embeds for the shared job/[id] route.
 * No role gate, but a local MISS answers from Supabase: a technician's
 * mirror only holds their assigned jobs, and this route is reachable for
 * jobs that are not theirs (e.g. via search) — locally-absent is not proof
 * of absence, so null falls through to the network instead of silently
 * rendering "Job not found" for a job the server would return.
 * (Note: fromLocalOr reports such a call as origin "local".)
 */
export async function getJob(id: string): Promise<JobDetail | null> {
  // Unchanged Supabase body (app/job/[id].tsx loadJob).
  const remote = async (): Promise<JobDetail | null> => {
    const res = await supabase
      .from("jobs")
      .select(
        "id, job_number, title, status, priority, description, notes, job_type, created_at, scheduled_start, scheduled_end, actual_start, actual_end, completion_notes, overtime_reason, overtime_category, voice_report_transcript, assigned_to, scheduled_cost_center_id, assigned_profile:profiles!jobs_assigned_to_fkey(full_name), customers(name, phone, mobile, email), sites(name, address_line1, suburb, state, postcode, site_lat, site_lng)"
      )
      .eq("id", id)
      .single();
    // .single() reports "no rows" as PGRST116, which unwrap maps to null —
    // absence is a normal answer here (the id may be a job this caller cannot
    // see), while a genuine failure still throws.
    return unwrap(res as never, "getJob") as unknown as JobDetail | null;
  };
  return fromLocalOr(async (db) => {
    const row = await db.getOptional<RawJobDetailRow>(SQL_GET_JOB, [id]);
    if (!row) return remote();
    return mapJobDetail(row);
  }, remote);
}

/**
 * Office jobs list, newest first — the infinite-scroll pagination path.
 * `.range(offset, offset + limit - 1)` ⇄ `LIMIT ? OFFSET ?`.
 */
export async function listOfficeJobs(offset: number, limit: number): Promise<OfficeJob[]> {
  return fromLocalOr(
    async (db) => {
      const rows = await db.getAll<RawOfficeJobRow>(SQL_LIST_OFFICE_JOBS, [limit, offset]);
      return rows.map(mapOfficeJob);
    },
    // Base body is app/(office)/jobs.tsx's original loadMore query, plus the
    // job_stage_notes embed (see OFFICE_SELECT_WITH_STAGE) scoped to the
    // single most recent row per job via the foreign-table order+limit below.
    async () => {
      const res = await supabase
        .from("jobs")
        .select(OFFICE_SELECT_WITH_STAGE)
        .order("created_at", { ascending: false })
        .order("id", { ascending: false })
        .order("created_at", { ascending: false, foreignTable: "job_stage_notes" })
        .limit(1, { foreignTable: "job_stage_notes" })
        .range(offset, offset + limit - 1);
      const rows = unwrapRows(res as never, "listOfficeJobs") as unknown as (OfficeJob & { job_stage_notes: { stage: string; created_at: string }[] })[];
      return rows.map((r) => ({ ...r, current_stage: currentStageFromEmbed(r.job_stage_notes) }));
    },
    ROLES
  );
}

/**
 * Office jobs server-side search (title substring, or exact job number when
 * the query is all digits). An empty/stripped-empty query returns the first
 * page unfiltered — exactly the screen's runSearch behaviour.
 */
export async function searchOfficeJobs(query: string, limit: number): Promise<OfficeJob[]> {
  return fromLocalOr(
    async (db) => {
      // Same [,()%]-strip as the Supabase path, then bound (not interpolated).
      const safe = query.replace(/[,()%]/g, " ").trim();
      const numeric = /^\d+$/.test(safe);
      const rows = await db.getAll<RawOfficeJobRow>(SQL_SEARCH_OFFICE_JOBS, [
        safe === "" ? null : safe,
        numeric ? Number(safe) : null,
        limit,
      ]);
      return rows.map(mapOfficeJob);
    },
    // Base body is app/(office)/jobs.tsx's original runSearch query, plus the
    // same job_stage_notes latest-row embed as listOfficeJobs above.
    async () => {
      const safe = query.replace(/[,()%]/g, " ").trim();
      let builder = supabase.from("jobs").select(OFFICE_SELECT_WITH_STAGE).order("created_at", { ascending: false })
        .order("id", { ascending: false })
        .order("created_at", { ascending: false, foreignTable: "job_stage_notes" })
        .limit(1, { foreignTable: "job_stage_notes" })
        .limit(limit);
      if (safe) {
        const numeric = /^\d+$/.test(safe);
        builder = builder.or(`title.ilike.%${safe}%${numeric ? `,job_number.eq.${safe}` : ""}`);
      }
      const res = await builder;
      const rows = unwrapRows(res as never, "searchOfficeJobs") as unknown as (OfficeJob & { job_stage_notes: { stage: string; created_at: string }[] })[];
      return rows.map((r) => ({ ...r, current_stage: currentStageFromEmbed(r.job_stage_notes) }));
    },
    ROLES
  );
}

/**
 * Whole-system job search (the technician Search tab): matching jobs, newest
 * first, capped at 50 — the screen's client-side haystack filter over its
 * 10,000-row pull, expressed as one function. Office/admin-gated: the screen
 * exists to find ANY job, and only an office/admin mirror holds them all —
 * a technician's mirror would silently hide every job that isn't theirs, so
 * technicians are always answered by Supabase.
 */
export async function searchJobs(query: string): Promise<JobSearchRow[]> {
  // The screen shows nothing until something is typed (useMemo: `if (!q) return []`).
  if (!query.trim()) return [];
  return fromLocalOr(
    async (db) => {
      const rows = await db.getAll<RawJobSearchRow>(SQL_SEARCH_JOBS, [escapeLike(query.trim())]);
      return rows.map(mapJobSearchRow);
    },
    async () => {
      // Unchanged Supabase body (app/(tabs)/search.tsx loadJobs) …
      const res = await supabase
        .from("jobs")
        .select("id, job_number, title, status, scheduled_start, customers(name), sites(name, address_line1, suburb, site_lat, site_lng)")
        .order("created_at", { ascending: false })
        .limit(10000);
      const allJobs = unwrapRows(res as never, "searchJobs") as unknown as JobSearchRow[];
      // … followed by the screen's client-side filter, moved verbatim
      // (app/(tabs)/search.tsx results useMemo).
      const q = query.trim().toLowerCase();
      return allJobs
        .filter((j) => {
          const haystack = [
            String(j.job_number),
            j.title,
            j.customers?.name,
            j.sites?.name,
            j.sites?.address_line1,
            j.sites?.suburb,
          ]
            .filter(Boolean)
            .join(" ")
            .toLowerCase();
          return haystack.includes(q);
        })
        .slice(0, 50);
    },
    ROLES
  );
}
