import { supabase } from "../../supabase";
import { unwrapRows } from "./unwrap";

// "Is this job MINE?" — one rule for every technician-facing job read.
//
// Since migration 0059 a job can be worked by a crew, and job_assignments is
// the source of truth for who is on it. jobs.assigned_to survives only as a
// trigger-derived PRIMARY assignee (the earliest-added current row), kept for
// readers that have not migrated.
//
// My Jobs and the geofence site list were two of those readers, and the gap was
// not cosmetic. The tech_jobs sync stream already scopes a technician's mirror
// through job_assignments, so the second technician on a crew job HAD the job on
// their phone — and then My Jobs filtered it back out on assigned_to, and the
// auto-clock never put a geofence round its site. They saw "No jobs assigned"
// and their time on that job was never auto-recorded.
//
// The rule here is "in job_assignments OR assigned_to", the same scope as
// user_can_manage_job() (0059), lib/api/job-authz.ts and the tech_* streams. The
// OR is belt and braces: the 0059 triggers keep the two in step both ways, so
// assigned_to should always also be in job_assignments — but a reader that
// trusts that and is wrong hides a job from the person standing on its site.

/**
 * SQLite predicate for the local mirror. `alias` is the jobs alias in the
 * enclosing statement; `param` the placeholder for the staff id (numbered, e.g.
 * `?1`, so the one value binds both halves).
 */
export function assignedOrCrewSql(alias: string, param: string): string {
  return `(${alias}.assigned_to = ${param} OR ${alias}.id IN (SELECT ja.job_id FROM job_assignments ja WHERE ja.staff_id = ${param}))`;
}

/** Narrows the crew lookup to the jobs the caller is about to filter on anyway. */
export type CrewJobScope =
  | { kind: "open" }
  // Jobs whose stored window touches [fromIso, beforeIso) — see overlapFilter.
  | { kind: "occupying"; fromIso: string; beforeIso: string };

/**
 * PostgREST `.or()` half of a window-overlap test (migration 0071 — a daily job
 * books every day of its range, not just the day it starts): the job ends on
 * or after `fromIso`, or has no end and STARTS on or after it (a start with no
 * end occupies its start day only — lib/scheduling.ts scheduleDays). Pair with
 * `scheduled_start < beforeIso`. Values are double-quoted because an ISO
 * instant carries `:` and `.`, which the logic-tree parser must not split.
 */
export function overlapFilter(fromIso: string): string {
  return `scheduled_end.gte."${fromIso}",and(scheduled_end.is.null,scheduled_start.gte."${fromIso}")`;
}

/**
 * Remote half: the ids of jobs `staffId` is on through job_assignments.
 *
 * Narrowed server-side to the jobs the caller is about to select, because the
 * ids travel back out in a URL — a technician's whole assignment history
 * (0059 backfilled every job ever assigned) would not fit in one.
 */
export async function crewJobIdsRemote(staffId: string, scope: CrewJobScope, context: string): Promise<string[]> {
  let query = supabase.from("job_assignments").select("job_id, jobs!inner(status, scheduled_start, scheduled_end)").eq("staff_id", staffId);
  query =
    scope.kind === "open"
      ? query.not("jobs.status", "in", '("completed","cancelled")')
      : query.lt("jobs.scheduled_start", scope.beforeIso).or(overlapFilter(scope.fromIso), { referencedTable: "jobs" });
  const rows = unwrapRows((await query) as never, context) as unknown as { job_id: string }[];
  return [...new Set(rows.map((r) => r.job_id))];
}

/** PostgREST `.or()` filter: assigned_to is the staff member, or the job is one of `crewJobIds`. */
export function assignedOrCrewFilter(staffId: string, crewJobIds: string[]): string {
  return crewJobIds.length > 0 ? `assigned_to.eq.${staffId},id.in.(${crewJobIds.join(",")})` : `assigned_to.eq.${staffId}`;
}
