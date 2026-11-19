// The office to-do list on the phone's Schedule tab — REMOTE ONLY, like the
// rest of that tab's reads (app/(office)/schedule.tsx asks Supabase for the
// schedule directly). Office/admin only: the screen lives in the (office)
// route group, and the jobs read runs under the caller's RLS.
//
// HOURS ONLY. A job without its own estimate falls back to its PO allocation
// from purchase_orders_public — the money-free view (0038), total_hours only —
// never purchase_orders. That fallback is best-effort: if it can't be read the
// job simply shows no hours (it still lists, and still fits every gap).
//
// The rules (hours, sort, "Fits in", what may be added) are the mirrored
// lib/todoList.ts and lib/todoBoard.ts.
import { supabase } from "../../supabase";
import { allocatedHoursByJob } from "../../todoList";
import { canAddToTodo, jobNumberQuery, TODO_SEARCH_LIMIT } from "../../todoBoard";
import { unwrapRows, type SupabaseResult } from "./unwrap";

/** A job on the to-do list, as the web's TodoJob (components/schedule/todo-list-panel.tsx). */
export interface TodoJob {
  id: string;
  job_number: number;
  title: string;
  priority: string;
  status: string;
  todo_listed_at: string;
  estimated_hours: number | null;
  po_allocated_hours: number | null;
  customer_name: string | null;
  suburb: string | null;
}

/** A job the "Add job…" search found: open, unscheduled and not yet listed. */
export interface TodoCandidate {
  id: string;
  job_number: number;
  title: string;
  status: string;
  priority: string;
  estimated_hours: number | null;
  customer_name: string | null;
  suburb: string | null;
}

type Row = Record<string, unknown> & {
  customers?: { name?: string | null } | null;
  sites?: { suburb?: string | null } | null;
};
type Result = SupabaseResult<Row[]>;

// The few PostgREST builder calls these reads make, over the untyped client
// (the schedule's own jobs reads go through it the same way).
interface Query extends PromiseLike<Result> {
  select(columns: string): Query;
  not(column: string, op: string, value: unknown): Query;
  order(column: string, opts: { ascending: boolean }): Query;
  in(column: string, values: readonly unknown[]): Query;
  is(column: string, value: null): Query;
  eq(column: string, value: unknown): Query;
  or(filter: string): Query;
  limit(n: number): Query;
}
const db = supabase as unknown as { from: (table: string) => Query };

const TODO_COLUMNS = "id, job_number, title, priority, status, todo_listed_at, estimated_hours, customers(name), sites(suburb)";
const SEARCH_COLUMNS = "id, job_number, title, status, priority, estimated_hours, todo_listed_at, scheduled_start, customers(name), sites(suburb)";

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Every job on the to-do list, longest-listed first (the screen sorts by
 * priority with sortTodoJobs). Throws when the list itself can't be read, so
 * the sheet can say so rather than show an empty list.
 */
export async function listTodoJobs(): Promise<TodoJob[]> {
  const rows = unwrapRows(
    await db.from("jobs").select(TODO_COLUMNS).not("todo_listed_at", "is", null).order("todo_listed_at", { ascending: true }),
    "listTodoJobs"
  );
  const needPo = rows.filter((r) => num(r.estimated_hours) === null).map((r) => String(r.id));
  let po = new Map<string, number>();
  if (needPo.length > 0) {
    try {
      const poRows = unwrapRows(await db.from("purchase_orders_public").select("job_id, total_hours").in("job_id", needPo), "listTodoJobs.poHours");
      po = allocatedHoursByJob(poRows as { job_id: string | null; total_hours: number | string | null }[]);
    } catch (e) {
      // Hours only; the job still lists without them.
      console.warn("[todo] PO hours unavailable:", e instanceof Error ? e.message : e);
    }
  }
  return rows.map((r) => ({
    id: String(r.id),
    job_number: Number(r.job_number),
    title: String(r.title ?? ""),
    priority: (r.priority as string | null) ?? "normal",
    status: String(r.status),
    todo_listed_at: String(r.todo_listed_at),
    estimated_hours: num(r.estimated_hours),
    po_allocated_hours: po.get(String(r.id)) ?? null,
    customer_name: r.customers?.name ?? null,
    suburb: r.sites?.suburb ?? null,
  }));
}

/** Words of the search box, with characters that would break a PostgREST or() removed (the web's customerSearchTokens). */
export function searchTokens(q: string): string[] {
  return q
    .replace(/[,()%*\\"]/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

/** Whether the box holds enough to search: two characters, or a job number. */
export function isSearchable(q: string): boolean {
  const term = q.trim();
  return term.length >= 2 || jobNumberQuery(term) !== null;
}

/**
 * "Add job…": open (pending / on hold), unscheduled, unlisted jobs by number,
 * or with every word in the title or the customer's name/company — the web
 * panel's search, at most TODO_SEARCH_LIMIT. Online only; throws on failure.
 */
export async function searchTodoCandidates(q: string): Promise<TodoCandidate[]> {
  const term = q.trim();
  if (!isSearchable(term)) return [];
  const base = () =>
    db
      .from("jobs")
      .select(SEARCH_COLUMNS)
      .in("status", ["pending", "on_hold"])
      .is("todo_listed_at", null)
      .is("scheduled_start", null)
      .order("job_number", { ascending: false })
      .limit(TODO_SEARCH_LIMIT);
  const number = jobNumberQuery(term);
  let rows: Row[];
  if (number !== null) {
    rows = unwrapRows(await base().eq("job_number", number), "searchTodoCandidates");
  } else {
    // PostgREST can't OR across an embedded table, so the customer match is
    // resolved to ids first (≤ 50), as the web panel and the Search tab do.
    const tokens = searchTokens(term);
    if (tokens.length === 0) return [];
    const customers = unwrapRows(
      await db
        .from("customers")
        .select("id")
        .or(tokens.map((t) => `name.ilike.%${t}%,company.ilike.%${t}%`).join(","))
        .limit(50),
      "searchTodoCandidates.customers"
    );
    const ids = customers.map((c) => String(c.id));
    let query = base();
    for (const t of tokens) query = query.or(ids.length > 0 ? `title.ilike.%${t}%,customer_id.in.(${ids.join(",")})` : `title.ilike.%${t}%`);
    rows = unwrapRows(await query, "searchTodoCandidates");
  }
  return rows
    .filter((r) =>
      canAddToTodo({
        status: String(r.status),
        todo_listed_at: (r.todo_listed_at as string | null) ?? null,
        scheduled_start: (r.scheduled_start as string | null) ?? null,
      }),
    )
    .map((r) => ({
      id: String(r.id),
      job_number: Number(r.job_number),
      title: String(r.title ?? ""),
      status: String(r.status),
      priority: (r.priority as string | null) ?? "normal",
      estimated_hours: num(r.estimated_hours),
      customer_name: r.customers?.name ?? null,
      suburb: r.sites?.suburb ?? null,
    }));
}
