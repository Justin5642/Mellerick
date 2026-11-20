// "Schedule an existing job" on the office Schedule tab (Justin's notebook
// list, 20 Nov 2026) — REMOTE ONLY, like the rest of that tab's reads. Office/
// admin only: the screen lives in the (office) route group, and the jobs read
// runs under the caller's RLS. No money: names, numbers and statuses.
//
// The rules (limit, open statuses, number vs words) are the mirrored
// lib/scheduleExistingJob.ts — the web board's search runs the same query.
import { supabase } from "../../supabase";
import {
  SCHEDULE_SEARCH_COLUMNS,
  SCHEDULE_SEARCH_LIMIT,
  UNSCHEDULABLE_STATUSES,
  canScheduleExistingJob,
  isScheduleSearchable,
  scheduleJobNumberQuery,
  scheduleSearchTokens,
} from "../../scheduleExistingJob";
import { unwrapRows, type SupabaseResult } from "./unwrap";

/** A job the search found: open (not completed or cancelled). */
export interface SchedulableJob {
  id: string;
  job_number: number;
  title: string;
  status: string;
  /** Already has a schedule (it can still get more bookings). */
  booked: boolean;
  customer_name: string | null;
  suburb: string | null;
}

type Row = Record<string, unknown> & {
  customers?: { name?: string | null; company?: string | null } | null;
  sites?: { suburb?: string | null } | null;
};
type Result = SupabaseResult<Row[]>;

interface Query extends PromiseLike<Result> {
  select(columns: string): Query;
  not(column: string, op: string, value: unknown): Query;
  order(column: string, opts: { ascending: boolean }): Query;
  eq(column: string, value: unknown): Query;
  or(filter: string): Query;
  limit(n: number): Query;
}
const db = supabase as unknown as { from: (table: string) => Query };

/**
 * Open jobs by number, or with every word in the title or the customer's
 * name/company — at most SCHEDULE_SEARCH_LIMIT, newest first. Throws on
 * failure (the sheet says so rather than "no jobs match").
 */
export async function searchSchedulableJobs(q: string): Promise<SchedulableJob[]> {
  const term = q.trim();
  if (!isScheduleSearchable(term)) return [];
  const base = () =>
    db
      .from("jobs")
      .select(SCHEDULE_SEARCH_COLUMNS)
      .not("status", "in", `(${UNSCHEDULABLE_STATUSES.join(",")})`)
      .order("job_number", { ascending: false })
      .limit(SCHEDULE_SEARCH_LIMIT);
  const number = scheduleJobNumberQuery(term);
  let rows: Row[];
  if (number !== null) {
    rows = unwrapRows(await base().eq("job_number", number), "searchSchedulableJobs");
  } else {
    // PostgREST can't OR across an embedded table, so the customer match is
    // resolved to ids first (≤ 50), as the web board and the to-do search do.
    const tokens = scheduleSearchTokens(term);
    if (tokens.length === 0) return [];
    const customers = unwrapRows(
      await db
        .from("customers")
        .select("id")
        .or(tokens.map((t) => `name.ilike.%${t}%,company.ilike.%${t}%`).join(","))
        .limit(50),
      "searchSchedulableJobs.customers"
    );
    const ids = customers.map((c) => String(c.id));
    let query = base();
    for (const t of tokens) query = query.or(ids.length > 0 ? `title.ilike.%${t}%,customer_id.in.(${ids.join(",")})` : `title.ilike.%${t}%`);
    rows = unwrapRows(await query, "searchSchedulableJobs");
  }
  return rows
    .filter((r) => canScheduleExistingJob({ status: String(r.status ?? "") }))
    .map((r) => ({
      id: String(r.id),
      job_number: Number(r.job_number),
      title: String(r.title ?? ""),
      status: String(r.status),
      booked: !!r.scheduled_start,
      // The company when there is one (as invoices are made out), else the contact.
      customer_name: (r.customers?.company ?? "").trim() || (r.customers?.name ?? "").trim() || null,
      suburb: r.sites?.suburb ?? null,
    }));
}
