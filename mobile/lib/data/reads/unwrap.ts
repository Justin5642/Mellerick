// Turning a swallowed Supabase error into a visible one.
//
// THE BUG THIS EXISTS FOR
// Every read module in this app was written as:
//
//     const { data } = await supabase.from("x").select(...);
//     return data ?? [];
//
// The error is destructured away. When the query fails — RLS denial, a column
// that no longer exists, a broken embed, an expired token — `data` is null and
// the caller gets an empty array. The screen then renders its EMPTY STATE, which
// says "No staff." or "No jobs assigned."
//
// That is indistinguishable from the truth, and it is the worst possible
// failure mode for this app: a technician who opens it on site and sees "no jobs
// assigned" because a query failed will go home. Nobody gets an error, nobody
// retries, and the office believes the work was never scheduled.
//
// This was found on 2026-08-03 when the Staff screen showed "No staff." on an
// admin account, while jobs in the same session clearly had staff assigned.
//
// USAGE
//     const rows = unwrap(await supabase.from("profiles").select(...), "listStaff");
//
// Callers that already tolerate failure (a badge, a count) can catch and degrade.
// Callers that render a list should let it propagate and show an error state —
// "we could not load this" is honest; an empty list is not.

export interface SupabaseResult<T> {
  data: T | null;
  error: { message: string; code?: string; details?: string | null; hint?: string | null } | null;
}

/**
 * Return the rows, or throw with enough context to diagnose from a log line.
 *
 * `context` should name the calling function — the Postgres message alone
 * ("column x does not exist") does not say which of 28 read sites produced it.
 */
/**
 * PostgREST reports "no rows" from `.single()` as an ERROR, not as data:null.
 * Absence is a normal answer for a single-row read — `getJob()` is reachable for
 * a job the caller may legitimately not have — so treating PGRST116 as a failure
 * would turn every missing row into a thrown error and a red screen.
 *
 * Matched on the CODE, never the message: "no rows in relation jobs" is a
 * missing TABLE (42P01), which is a real fault and must still throw.
 */
const NO_ROWS = "PGRST116";

export function unwrap<T>(result: SupabaseResult<T>, context: string): T {
  if (result.error) {
    if (result.error.code === NO_ROWS) return null as T;
    const { message, code, details, hint } = result.error;
    const parts = [message];
    if (code) parts.push(`code=${code}`);
    if (details) parts.push(details);
    if (hint) parts.push(`hint: ${hint}`);
    throw new Error(`${context}: ${parts.join(" | ")}`);
  }
  // A successful query with no rows legitimately returns null for maybeSingle();
  // the caller decides what an absent row means. Only an ERROR is exceptional.
  return result.data as T;
}

/**
 * Same, for list reads: an error throws, and a successful-but-empty result comes
 * back as `[]` rather than null so callers need no second null check.
 */
export function unwrapRows<T>(result: SupabaseResult<T[]>, context: string): T[] {
  return unwrap(result, context) ?? [];
}

/**
 * Same, for `select("*", { count: "exact", head: true })` reads, which return a
 * count and NO data — so neither helper above can express them.
 *
 * This one is easy to skip, because the failure looks like an answer: a broken
 * per-status count read as `count ?? 0` renders "0 jobs" on a dashboard, and a
 * zero on a dashboard gets believed. A thrown error does not.
 */
export function unwrapCount(
  result: { count: number | null; error: SupabaseResult<unknown>["error"] },
  context: string
): number {
  unwrap({ data: null, error: result.error }, context);
  return result.count ?? 0;
}
