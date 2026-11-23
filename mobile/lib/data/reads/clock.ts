import { supabase } from "../../supabase";
import { fromLocalOr } from "./source";
import { unwrapRows } from "./unwrap";

// Is this technician on the clock? Read by the location-tracking gate
// (lib/trackingGate.ts), which keeps GPS on regardless of the time of day while
// a work entry is open.
//
// No role gate: tech_time_entries carries the technician's own entries (on the
// jobs they are assigned to) and an office/admin mirror carries everyone's; the
// staff_id filter narrows either identically. Like every mirror read it can lag
// an offline clock-in — the gate covers that from the outbox, not here.

/** Latest open work entry's clock-in. */
export const SQL_LATEST_OPEN_WORK_ENTRY = `
  SELECT clock_in FROM time_entries
  WHERE staff_id = ? AND entry_type = 'work' AND clock_out IS NULL
  ORDER BY clock_in DESC
  LIMIT 1`;

export interface OpenWorkEntry {
  clockInIso: string;
}

export async function getOpenWorkEntry(staffId: string): Promise<OpenWorkEntry | null> {
  return fromLocalOr(
    async (db) => {
      const row = await db.getOptional<{ clock_in: string }>(SQL_LATEST_OPEN_WORK_ENTRY, [staffId]);
      return row ? { clockInIso: row.clock_in } : null;
    },
    async () => {
      const res = await supabase
        .from("time_entries")
        .select("clock_in")
        .eq("staff_id", staffId)
        .eq("entry_type", "work")
        .is("clock_out", null)
        .order("clock_in", { ascending: false })
        .limit(1);
      const [row] = unwrapRows(res as never, "getOpenWorkEntry") as unknown as { clock_in: string }[];
      return row ? { clockInIso: row.clock_in } : null;
    }
  );
}

/** This person's open work entry on one job, for clocking them off at sign-off. */
export const SQL_OPEN_WORK_ENTRY_ON_JOB = `
  SELECT id, clock_in, cost_center_id FROM time_entries
  WHERE staff_id = ? AND job_id = ? AND entry_type = 'work' AND clock_out IS NULL
  ORDER BY clock_in DESC
  LIMIT 1`;

export async function getOpenWorkEntryOnJob(
  staffId: string,
  jobId: string
): Promise<{ id: string; clockInIso: string; costCenterId: string | null } | null> {
  return fromLocalOr(
    async (db) => {
      const row = await db.getOptional<{ id: string; clock_in: string; cost_center_id: string | null }>(SQL_OPEN_WORK_ENTRY_ON_JOB, [staffId, jobId]);
      return row ? { id: row.id, clockInIso: row.clock_in, costCenterId: row.cost_center_id ?? null } : null;
    },
    async () => {
      const res = await supabase
        .from("time_entries")
        .select("id, clock_in, cost_center_id")
        .eq("staff_id", staffId)
        .eq("job_id", jobId)
        .eq("entry_type", "work")
        .is("clock_out", null)
        .order("clock_in", { ascending: false })
        .limit(1);
      const [row] = unwrapRows(res as never, "getOpenWorkEntryOnJob") as unknown as { id: string; clock_in: string; cost_center_id: string | null }[];
      return row ? { id: row.id, clockInIso: row.clock_in, costCenterId: row.cost_center_id ?? null } : null;
    }
  );
}

/**
 * Every open work entry of this person's, with its job and whether the job's
 * site has a map pin — for the clock prompts (lib/dwellPrompt.ts: "left the
 * site" and "still clocked on"). Money-free: not even hours are selected.
 */
export const SQL_MY_OPEN_WORK_ENTRIES = `
  SELECT te.id, te.job_id, te.clock_in, j.job_number, j.title, s.site_lat, s.site_lng
  FROM time_entries te
  LEFT JOIN jobs  j ON j.id = te.job_id
  LEFT JOIN sites s ON s.id = j.site_id
  WHERE te.staff_id = ? AND te.entry_type = 'work' AND te.clock_out IS NULL
  ORDER BY te.clock_in DESC`;

export interface MyOpenWorkEntry {
  entryId: string;
  jobId: string;
  clockInIso: string;
  jobNumber: number | null;
  title: string;
  pinned: boolean;
}

export interface RawOpenWorkEntryRow {
  id: string;
  job_id: string;
  clock_in: string;
  job_number: number | string | null;
  title: string | null;
  site_lat: number | string | null;
  site_lng: number | string | null;
}

/** Shared by both paths. A 0/0 pin is no pin (the geofence's rule). */
export function mapOpenWorkEntry(r: RawOpenWorkEntryRow): MyOpenWorkEntry {
  const n = r.job_number == null ? null : Number(r.job_number);
  return {
    entryId: r.id,
    jobId: r.job_id,
    clockInIso: r.clock_in,
    jobNumber: n != null && Number.isFinite(n) ? n : null,
    title: r.title ?? "",
    pinned: !!Number(r.site_lat) && !!Number(r.site_lng),
  };
}

export async function listMyOpenWorkEntries(staffId: string): Promise<MyOpenWorkEntry[]> {
  return fromLocalOr(
    async (db) => (await db.getAll<RawOpenWorkEntryRow>(SQL_MY_OPEN_WORK_ENTRIES, [staffId])).map(mapOpenWorkEntry),
    async () => {
      const res = await supabase
        .from("time_entries")
        .select("id, job_id, clock_in, jobs!time_entries_job_id_fkey(job_number, title, sites(site_lat, site_lng))")
        .eq("staff_id", staffId)
        .eq("entry_type", "work")
        .is("clock_out", null)
        .order("clock_in", { ascending: false });
      type Remote = {
        id: string;
        job_id: string;
        clock_in: string;
        jobs: { job_number: number | null; title: string | null; sites: { site_lat: number | null; site_lng: number | null } | null } | null;
      };
      return (unwrapRows(res as never, "listMyOpenWorkEntries") as unknown as Remote[]).map((r) =>
        mapOpenWorkEntry({
          id: r.id,
          job_id: r.job_id,
          clock_in: r.clock_in,
          job_number: r.jobs?.job_number ?? null,
          title: r.jobs?.title ?? null,
          site_lat: r.jobs?.sites?.site_lat ?? null,
          site_lng: r.jobs?.sites?.site_lng ?? null,
        })
      );
    }
  );
}
