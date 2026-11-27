import { fetchAllRows, type RangeableQuery } from "@/lib/fetch-all-rows";
import { summariseJobHours, type HoursByJob, type OverHoursEntry, type OverHoursLine, type OverHoursPo } from "@/lib/over-hours";

/**
 * The reads behind the schedule board's "Over allowed hours" alert
 * (lib/over-hours.ts). Run as the CALLER — the board only asks for an
 * office/admin viewer — so RLS decides, never the service role.
 *
 * HOURS ONLY (HANDOVER.md §2). Allowed hours come from the money-free views
 * (purchase_orders_public.total_hours, po_cost_centers_public.allocated_hours);
 * used hours from time_entries' hour/clock columns. No amount, value or rate
 * column is selected — tests/unit/over-hours-data.test.ts pins the column lists.
 *
 * Only the jobs given (those on the board), `.in()` in chunks so the URL stays
 * short, and every chunk paged (lib/fetch-all-rows.ts) so PostgREST's
 * 1000-row cap never silently drops time entries.
 */

export const OVER_HOURS_PO_COLUMNS = "id, job_id, total_hours";
export const OVER_HOURS_LINE_COLUMNS = "id, po_id, name, allocated_hours";
export const OVER_HOURS_ENTRY_COLUMNS = "job_id, cost_center_id, hours, clock_in, clock_out, entry_type";
/** With 0120 (draft)'s variation_id, so variation time is left out of the allowed hours. Read first; the list above is the fallback. */
export const OVER_HOURS_ENTRY_COLUMNS_WITH_VARIATION = `${OVER_HOURS_ENTRY_COLUMNS}, variation_id`;

/** Ids per `.in()` request: uuids are 36 characters, so ~4 kB of URL. */
export const OVER_HOURS_CHUNK = 100;

type Filterable<T> = RangeableQuery<T> & {
  in: (column: string, values: readonly string[]) => Filterable<T>;
  neq: (column: string, value: string) => Filterable<T>;
  order: (column: string, opts?: { ascending?: boolean }) => Filterable<T>;
};

/** The one method used, narrowed (the generic typed client trips TS2589 on a structural match). */
export type OverHoursClient = {
  from: (table: string) => { select: (columns: string, opts?: { count?: "exact" }) => Filterable<unknown> };
};

function chunks<T>(list: readonly T[], size = OVER_HOURS_CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

async function readIn<T>(
  client: OverHoursClient,
  table: string,
  columns: string,
  column: string,
  ids: readonly string[],
  extra?: (q: Filterable<unknown>) => Filterable<unknown>,
): Promise<T[]> {
  const results = await Promise.all(
    chunks(ids).map((part) =>
      fetchAllRows<unknown>((count) => {
        const q = client.from(table).select(columns, count).in(column, part);
        return (extra ? extra(q) : q).order("id");
      }),
    ),
  );
  const rows: T[] = [];
  for (const r of results) {
    if (!r.ok) throw new Error(`over-hours ${table}: ${r.error}`);
    rows.push(...(r.rows as T[]));
  }
  return rows;
}

/**
 * Work entries for these jobs, with variation_id (0120 (draft)) — or, on a database
 * without it (42703 / PGRST204 naming the column), without it: every entry is
 * then the stage's, exactly as before.
 */
async function readEntries(client: OverHoursClient, ids: readonly string[]): Promise<OverHoursEntry[]> {
  const travelOff = (q: Filterable<unknown>) => q.neq("entry_type", "travel");
  try {
    return await readIn<OverHoursEntry>(client, "time_entries", OVER_HOURS_ENTRY_COLUMNS_WITH_VARIATION, "job_id", ids, travelOff);
  } catch (e) {
    if (!/variation_id/.test(e instanceof Error ? e.message : String(e))) throw e;
    return readIn<OverHoursEntry>(client, "time_entries", OVER_HOURS_ENTRY_COLUMNS, "job_id", ids, travelOff);
  }
}

/**
 * Used and allowed hours for these jobs, or null when any read failed — the
 * board then shows no badges rather than a partial (and so wrong) answer.
 */
export async function loadJobHours(client: OverHoursClient, jobIds: readonly string[], nowMs = Date.now()): Promise<HoursByJob | null> {
  const ids = Array.from(new Set(jobIds));
  if (ids.length === 0) return {};
  try {
    const [pos, entries] = await Promise.all([
      readIn<{ id: string | null; job_id: string | null; total_hours: number | string | null }>(
        client,
        "purchase_orders_public",
        OVER_HOURS_PO_COLUMNS,
        "job_id",
        ids,
      ),
      // time_entries has an id; the views above are ordered by theirs.
      readEntries(client, ids),
    ]);
    const jobByPo = new Map<string, string>();
    for (const po of pos) if (po.id && po.job_id) jobByPo.set(po.id, po.job_id);
    const lineRows = await readIn<{ id: string | null; po_id: string | null; name: string | null; allocated_hours: number | string | null }>(
      client,
      "po_cost_centers_public",
      OVER_HOURS_LINE_COLUMNS,
      "po_id",
      [...jobByPo.keys()],
    );
    const lines: OverHoursLine[] = [];
    for (const l of lineRows) {
      const jobId = l.po_id ? jobByPo.get(l.po_id) : undefined;
      if (l.id && jobId) lines.push({ id: l.id, job_id: jobId, name: l.name, allocated_hours: l.allocated_hours });
    }
    const poRows: OverHoursPo[] = pos.flatMap((p) => (p.job_id ? [{ job_id: p.job_id, total_hours: p.total_hours }] : []));
    return summariseJobHours({ pos: poRows, lines, entries, nowMs });
  } catch (e) {
    console.error("[schedule] over-hours unavailable:", e instanceof Error ? e.message : e);
    return null;
  }
}
