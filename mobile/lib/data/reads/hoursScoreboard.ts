import { supabase } from "../../supabase";
import { fromLocalOr, type LocalReads } from "./source";
import { num, numOrNull } from "./rowMap";
import { unwrapRows } from "./unwrap";

// Reads behind components/job/hours-scoreboard.tsx — allocated hours (from the
// job's purchase orders) vs logged WORK hours (time_entries). HOURS ONLY: no
// money column is selected on either path, for any role (HANDOVER §2).
//
// Role routing, from what each mirror actually holds (powersync/
// sync-streams.yaml) and what RLS returns remotely:
//
//  • Allocated hours — LOCAL for office/admin only. They sync
//    `purchase_orders.*`, and purchase_orders_public (migration 0038) is an
//    unfiltered projection of that table, so SUM(total_hours) is identical.
//    Technicians do not sync purchase_orders at all (the base table carries
//    total_value), so they stay on the purchase_orders_public view remotely.
//
//  • Work time entries — LOCAL for every role, but the technician query is
//    narrowed to THEIR OWN entries. Remotely, RLS ("Users can manage own time
//    entries", 0000_baseline) returns a technician only rows with
//    staff_id = auth.uid(), while the tech_time_entries stream carries the
//    whole crew's entries for the job. Serving the stream unfiltered would make
//    the scoreboard change its numbers depending on signal — so the local
//    query reproduces the RLS filter exactly.
//    A job absent from the mirror (a technician viewing a job they are not
//    assigned to) answers from Supabase: locally-absent is not proof of absence.

export interface WorkTimeEntry {
  hours: number | null;
  clock_in: string | null;
  clock_out: string | null;
}

export const SQL_JOB_PO_HOURS = `
  SELECT total_hours FROM purchase_orders WHERE job_id = ?`;

export const SQL_JOB_IN_MIRROR = `
  SELECT id FROM jobs WHERE id = ?`;

/** Office/admin: every work entry on the job (RLS gives them all rows). */
export const SQL_JOB_WORK_ENTRIES_ALL = `
  SELECT hours, clock_in, clock_out FROM time_entries
  WHERE job_id = ? AND entry_type = 'work'`;

/** Technician: only their own — the same rows RLS returns them remotely. */
export const SQL_JOB_WORK_ENTRIES_OWN = `
  SELECT hours, clock_in, clock_out FROM time_entries
  WHERE job_id = ? AND entry_type = 'work' AND staff_id = ?`;

interface RawEntry {
  hours: number | string | null;
  clock_in: string | null;
  clock_out: string | null;
}

const mapEntry = (r: RawEntry): WorkTimeEntry => ({
  hours: numOrNull(r.hours),
  clock_in: r.clock_in ?? null,
  clock_out: r.clock_out ?? null,
});

const sumHours = (rows: { total_hours: number | string | null }[]) =>
  rows.reduce((sum, r) => sum + num(r.total_hours), 0);

/** Total hours allocated to the job across its purchase orders. */
export async function getJobAllocatedHours(jobId: string): Promise<number> {
  return fromLocalOr(
    async (db) => sumHours(await db.getAll<{ total_hours: number | string | null }>(SQL_JOB_PO_HOURS, [jobId])),
    async () => {
      const res = await supabase.from("purchase_orders_public").select("total_hours").eq("job_id", jobId);
      return sumHours(unwrapRows(res as never, "getJobAllocatedHours") as { total_hours: number | string | null }[]);
    },
    { roles: ["office", "admin"] }
  );
}

/**
 * The job's WORK time entries as the caller is entitled to see them — travel
 * time is tracked separately and does not count against the allocation.
 */
export async function listJobWorkTimeEntries(jobId: string, userId: string | null): Promise<WorkTimeEntry[]> {
  const remote = async (): Promise<WorkTimeEntry[]> => {
    const res = await supabase
      .from("time_entries")
      .select("hours, clock_in, clock_out")
      .eq("job_id", jobId)
      .eq("entry_type", "work");
    return (unwrapRows(res as never, "listJobWorkTimeEntries") as RawEntry[]).map(mapEntry);
  };
  return fromLocalOr(async (db: LocalReads) => {
    if (!(await db.getOptional<{ id: string }>(SQL_JOB_IN_MIRROR, [jobId]))) return remote();
    const role = db.role();
    if (role === "technician") {
      // No id to reproduce the RLS filter with: do not guess.
      if (!userId) return remote();
      return (await db.getAll<RawEntry>(SQL_JOB_WORK_ENTRIES_OWN, [jobId, userId])).map(mapEntry);
    }
    if (role === "office" || role === "admin") {
      return (await db.getAll<RawEntry>(SQL_JOB_WORK_ENTRIES_ALL, [jobId])).map(mapEntry);
    }
    return remote();
  }, remote);
}
