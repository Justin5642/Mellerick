// "Over allowed hours" on the office Schedule tab (Justin, 24 Nov 2026) —
// REMOTE ONLY, like the rest of that tab's reads, and best-effort: a failure
// answers null and the grid shows no badges. Office/admin only: the screen
// lives in the (office) route group and checks the role again; every read
// runs under the caller's RLS.
//
// HOURS ONLY (HANDOVER.md §2). Allowed hours from the money-free views
// (purchase_orders_public.total_hours, po_cost_centers_public.allocated_hours);
// used hours from time_entries' hour/clock columns. The same reads as the web
// board's lib/over-hours-data.ts; the rule is the mirrored lib/overHours.ts.
import { supabase } from "../../supabase";
import { summariseJobHours, type HoursByJob, type OverHoursEntry, type OverHoursLine, type OverHoursPo } from "../../overHours";
import { chunkIds, mergeResults, readAllPages } from "./pagedRows";
import { unwrapRows, type SupabaseResult } from "./unwrap";

export const OVER_HOURS_PO_COLUMNS = "id, job_id, total_hours";
export const OVER_HOURS_LINE_COLUMNS = "id, po_id, name, allocated_hours";
export const OVER_HOURS_ENTRY_COLUMNS = "job_id, cost_center_id, hours, clock_in, clock_out, entry_type";

type Row = Record<string, unknown>;
interface Query extends PromiseLike<SupabaseResult<Row[]>> {
  select(columns: string): Query;
  in(column: string, values: readonly unknown[]): Query;
  neq(column: string, value: unknown): Query;
  order(column: string): Query;
  range(from: number, to: number): Query;
}
const db = supabase as unknown as { from: (table: string) => Query };

async function readIn(table: string, columns: string, column: string, ids: readonly string[], travelOff = false): Promise<Row[]> {
  const res = mergeResults(
    await Promise.all(
      chunkIds(ids).map((part) =>
        readAllPages<Row>((from, to) => {
          let q = db.from(table).select(columns).in(column, part);
          if (travelOff) q = q.neq("entry_type", "travel");
          return q.order("id").range(from, to);
        })
      )
    )
  );
  return unwrapRows(res, `listJobHours ${table}`);
}

const text = (v: unknown) => (typeof v === "string" ? v : null);
const hours = (v: unknown) => (typeof v === "number" || typeof v === "string" ? v : null);

/** Used and allowed hours for these jobs; null when anything couldn't be read (never a partial answer). */
export async function listJobHours(jobIds: readonly string[], nowMs = Date.now()): Promise<HoursByJob | null> {
  const ids = Array.from(new Set(jobIds));
  if (ids.length === 0) return {};
  try {
    const [pos, entryRows] = await Promise.all([
      readIn("purchase_orders_public", OVER_HOURS_PO_COLUMNS, "job_id", ids),
      readIn("time_entries", OVER_HOURS_ENTRY_COLUMNS, "job_id", ids, true),
    ]);
    const jobByPo = new Map<string, string>();
    for (const po of pos) {
      const id = text(po.id);
      const jobId = text(po.job_id);
      if (id && jobId) jobByPo.set(id, jobId);
    }
    const lineRows = await readIn("po_cost_centers_public", OVER_HOURS_LINE_COLUMNS, "po_id", [...jobByPo.keys()]);
    const lines: OverHoursLine[] = [];
    for (const l of lineRows) {
      const id = text(l.id);
      const poId = text(l.po_id);
      const jobId = poId ? jobByPo.get(poId) : undefined;
      if (id && jobId) lines.push({ id, job_id: jobId, name: text(l.name), allocated_hours: hours(l.allocated_hours) });
    }
    const poRows: OverHoursPo[] = pos.flatMap((p) => {
      const jobId = text(p.job_id);
      return jobId ? [{ job_id: jobId, total_hours: hours(p.total_hours) }] : [];
    });
    const entries: OverHoursEntry[] = entryRows.flatMap((e) => {
      const jobId = text(e.job_id);
      return jobId
        ? [{ job_id: jobId, cost_center_id: text(e.cost_center_id), hours: hours(e.hours), clock_in: text(e.clock_in), clock_out: text(e.clock_out), entry_type: text(e.entry_type) }]
        : [];
    });
    return summariseJobHours({ pos: poRows, lines, entries, nowMs });
  } catch (e) {
    console.warn("[schedule] over-hours unavailable:", e);
    return null;
  }
}
