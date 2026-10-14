import { supabase } from "../../supabase";
import { fromLocalOr } from "./source";
import { requireCoveredSince } from "./horizon";
import { unwrapRows } from "./unwrap";
import { assignedOrCrewFilter, assignedOrCrewSql, crewJobIdsRemote, overlapFilter } from "./assignedJobs";
import { bool } from "./rowMap";
import { businessDayRange, occupiesDay } from "../../scheduling";

export interface AssignableStaff {
  id: string;
  full_name: string;
  role: string;
}

// Local (PowerSync) equivalent of the Supabase query below. `is_active`
// reaches the device via profiles stream v2. COLLATE NOCASE approximates
// PG's case-insensitive collation; `full_name` is NOT NULL, so no
// `IS NULL` ordering prefix is needed.
export const SQL_LIST_ASSIGNABLE_STAFF = `
  SELECT id, full_name, role FROM profiles WHERE is_active = 1
  ORDER BY full_name COLLATE NOCASE`;

// Active staff for the schedule's technician picker. Selects only non-payroll
// columns (id/name/role) so it works for office users too (staff_cost_profiles
// is admin-only). Technicians first, then office/admin, then by name.
export async function listAssignableStaff(): Promise<AssignableStaff[]> {
  return fromLocalOr(
    async (db) => {
      const rows = await db.getAll<AssignableStaff>(SQL_LIST_ASSIGNABLE_STAFF, []);
      // Same role re-sort as the Supabase path below, unchanged: the SQL's
      // full_name order is the tiebreak, role rank is the primary key.
      const rank = (r: string) => (r === "technician" ? 0 : r === "office" ? 1 : 2);
      return [...rows].sort((a, b) => rank(a.role) - rank(b.role) || a.full_name.localeCompare(b.full_name));
    },
    async () => {
      // ← unchanged pre-PowerSync Supabase body (byte-identical fallback).
      const res = await supabase
        .from("profiles")
        .select("id, full_name, role")
        .eq("is_active", true)
        .order("full_name");
      const rows = unwrapRows(res as never, "listAssignableStaff") as unknown as AssignableStaff[];
      const rank = (r: string) => (r === "technician" ? 0 : r === "office" ? 1 : 2);
      // Stable: role first, then alphabetical (the query's full_name order isn't
      // preserved by a role-only sort).
      return [...rows].sort((a, b) => rank(a.role) - rank(b.role) || a.full_name.localeCompare(b.full_name));
    },
    { roles: ["office", "admin"] }
  );
}

// How many jobs (other than `excludeJobId`) a technician already has booked
// on a given business date — feeds the Schedule Job flow's "All day" smart
// default (lib/scheduling.ts's defaultAllDay). Counts crew jobs too
// (./assignedJobs): a technician who is the second name on a morning job is
// not free that morning.
//
// "Booked on" means OCCUPIES the day (migration 0071, draft), not "starts on it": a
// Mon–Wed daily job books Tuesday too. The SQL is a coarse overlap on the
// stored window (starts before the day ends; ends — or, with no end, starts —
// on or after it begins); occupiesDay() then drops a daily job's skipped
// weekend and a block that only grazes the day. Both paths fetch the same
// columns and narrow through the same countOccupying(), so they cannot
// disagree about which days a job books.
export const SQL_COUNT_OTHER_SCHEDULED_JOBS = `
  SELECT j.id, j.scheduled_start, j.scheduled_end, j.schedule_daily FROM jobs j
  WHERE ${assignedOrCrewSql("j", "?1")}
    AND j.id != ?2 AND j.scheduled_start < ?4
    AND (j.scheduled_end >= ?3 OR (j.scheduled_end IS NULL AND j.scheduled_start >= ?3))`;

export interface OccupancyRow {
  id: string;
  scheduled_start: string | null;
  scheduled_end: string | null;
  /** SQLite 1/0 locally, true/false from PostgREST — both go through bool(). */
  schedule_daily: boolean | number | null;
}

/** Shared by both paths: how many of these rows book `dateKey`. */
export function countOccupying(rows: OccupancyRow[], dateKey: string): number {
  return rows.filter((r) =>
    occupiesDay(
      { scheduled_start: r.scheduled_start, scheduled_end: r.scheduled_end, schedule_daily: bool(r.schedule_daily) ?? false },
      dateKey
    )
  ).length;
}

export async function countOtherScheduledJobs(
  technicianId: string,
  dateKey: string,
  excludeJobId: string
): Promise<number> {
  const { dayStartIso, dayEndIso } = businessDayRange(dateKey);
  return fromLocalOr(
    async (db) => {
      // The office window (0068) keeps any job whose start OR end is after the
      // cutoff, and a job booked on this day ends on or after the day begins —
      // so when the day is inside the window, every such job is on the device.
      // A day further back than that (rare — scheduling is forward-looking)
      // asks the server.
      await requireCoveredSince(db, "office", dayStartIso, "countOtherScheduledJobs");
      const rows = await db.getAll<OccupancyRow>(SQL_COUNT_OTHER_SCHEDULED_JOBS, [
        technicianId,
        excludeJobId,
        dayStartIso,
        dayEndIso,
      ]);
      return countOccupying(rows, dateKey);
    },
    async () => {
      const crew = await crewJobIdsRemote(
        technicianId,
        { kind: "occupying", fromIso: dayStartIso, beforeIso: dayEndIso },
        "countOtherScheduledJobs"
      );
      // Two .or() params: PostgREST ANDs separate logic-tree params.
      const res = await supabase
        .from("jobs")
        .select("id, scheduled_start, scheduled_end, schedule_daily")
        .or(assignedOrCrewFilter(technicianId, crew))
        .neq("id", excludeJobId)
        .lt("scheduled_start", dayEndIso)
        .or(overlapFilter(dayStartIso));
      return countOccupying(unwrapRows(res as never, "countOtherScheduledJobs") as unknown as OccupancyRow[], dateKey);
    },
    { roles: ["office", "admin"] }
  );
}
