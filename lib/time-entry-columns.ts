/**
 * The columns of `time_entries` that role `authenticated` may SELECT.
 *
 * WHY THIS EXISTS — this is not a style preference, it is a production outage fix.
 *
 * Migration 0045 hid `time_entries.rate_override` by dropping the TABLE-level
 * SELECT grant and re-granting every other column individually. Under
 * column-level grants Postgres refuses `select *` outright, because `*` expands
 * to every column including the revoked one:
 *
 *     set role authenticated;
 *     select * from time_entries limit 1;
 *     -- ERROR: permission denied for table time_entries
 *
 * (Verified by impersonation against the production database on 2026-08-04.)
 *
 * Five call sites did `select("*, profiles!...")`. All five were refused, and
 * the two on the clock-in/clock-out path discarded the error — so a technician
 * tapped Clock In, saw a success toast, and no row was written. 0045's own
 * header asserts "no query does `select *` on time_entries"; that was already
 * untrue when it was written.
 *
 * Every read of `time_entries` from a browser/session client MUST use this list.
 *
 * ADDING A COLUMN: add it here AND run `select reapply_time_entries_grants();`
 * at the end of the migration (see 0046), or the column is granted but unlisted
 * — readable yet never fetched, which is the quiet half of the same bug.
 *
 * NOT INCLUDED, deliberately: `rate_override`. No `authenticated` user can read
 * it, admins included. Per 0045: do not re-grant it — expose it through an
 * office/admin-gated view or a service-role route that authorises the caller.
 */
/*
 * Written as one literal rather than a joined array ON PURPOSE. supabase-js
 * parses the select string AT THE TYPE LEVEL to infer the row shape; an array
 * `.join(", ")` widens to `string`, the inference collapses to
 * `GenericStringError`, and every caller then needs an `as unknown as` cast —
 * which would throw away exactly the checking that makes this list safe.
 */
// The clock_in_/clock_out_ position columns (0092)
// are granted explicitly there.
// invoice_id is 0098 (applied in production 15 Nov 2026).
export const TIME_ENTRY_COLUMNS =
  "id, job_id, staff_id, clock_in, clock_out, hours, notes, auto_clocked, created_at, entry_type, travel_from_job_id, cost_center_id, edited_by, edited_at, clock_in_lat, clock_in_lng, clock_in_accuracy, clock_out_lat, clock_out_lng, clock_out_accuracy, invoice_id" as const;

/**
 * The same list plus the staff-name embed.
 *
 * `time_entries` has two FKs to `profiles` (`staff_id`, `edited_by`), so an
 * unhinted `profiles(...)` embed is ambiguous and PostgREST rejects the whole
 * query with PGRST201. The FK must be named explicitly.
 */
export const TIME_ENTRY_SELECT_WITH_STAFF =
  `${TIME_ENTRY_COLUMNS}, profiles!time_entries_staff_id_fkey(full_name)` as const;

/**
 * Columns a database may not have yet, so they are NOT in the list above —
 * naming a missing column fails the whole read (42703), and the clock-on and
 * clock-off paths read back through that list. They are read with the
 * `…_WITH_VARIATION` lists below, falling back to the plain list on a database
 * without them (withVariationFallback). Today: variation_id (0120, draft).
 */
export const TIME_ENTRY_OPTIONAL_COLUMNS = ["variation_id"] as const;

/** The list plus 0120 (draft)'s variation_id — read first, with the plain list as the fallback. */
export const TIME_ENTRY_COLUMNS_WITH_VARIATION = `${TIME_ENTRY_COLUMNS}, variation_id` as const;

export const TIME_ENTRY_SELECT_WITH_STAFF_AND_VARIATION =
  `${TIME_ENTRY_COLUMNS_WITH_VARIATION}, profiles!time_entries_staff_id_fkey(full_name)` as const;

/**
 * Run a read with the variation column; on a database without it (0120 (draft) not
 * applied: 42703 / PGRST204 naming the column) run it again without. Any
 * other error is returned as it came.
 */
export async function withVariationFallback<R extends { error: { code?: string; message?: string } | null }>(
  run: (columns: string) => PromiseLike<R>,
  columns: { withVariation: string; without: string }
): Promise<R> {
  const first = await run(columns.withVariation);
  const e = first.error;
  if (e && ["42703", "PGRST204", "PGRST200"].includes(e.code ?? "") && /variation_id/.test(e.message ?? "")) {
    return run(columns.without);
  }
  return first;
}
