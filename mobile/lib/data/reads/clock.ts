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
