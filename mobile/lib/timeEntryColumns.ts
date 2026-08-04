/**
 * The columns of `time_entries` that role `authenticated` may SELECT.
 *
 * MIRRORS `lib/time-entry-columns.ts` in the web app. The two packages have
 * separate lockfiles and no workspace linking them, so this cannot be imported —
 * it is duplicated deliberately. `tests/unit/time-entry-columns.test.ts` asserts
 * the two lists are identical, so a change to one that is not mirrored fails CI
 * rather than silently breaking the other platform.
 *
 * WHY EXPLICIT COLUMNS — migration 0045 dropped the TABLE-level SELECT grant on
 * `time_entries` and re-granted every column except `rate_override`. Under
 * column-level grants Postgres refuses `select *` outright, because `*` expands
 * to the revoked column too. Verified against production 2026-08-04:
 *
 *     set role authenticated;
 *     select * from time_entries limit 1;
 *     -- ERROR: permission denied for table time_entries
 *
 * ADDING A COLUMN: add it here, in the web list, AND run
 * `select reapply_time_entries_grants();` at the end of the migration (0046).
 *
 * NOT INCLUDED, deliberately: `rate_override`.
 */
/*
 * One literal, not a joined array — supabase-js infers the row shape from the
 * select string at the type level, and `.join(", ")` widens it to `string`,
 * collapsing inference to `GenericStringError`.
 */
export const TIME_ENTRY_COLUMNS =
  "id, job_id, staff_id, clock_in, clock_out, hours, notes, auto_clocked, created_at, entry_type, travel_from_job_id, cost_center_id, edited_by, edited_at" as const;

/**
 * The same list plus the staff-name embed. `time_entries` has two FKs to
 * `profiles` (`staff_id`, `edited_by`), so an unhinted embed is ambiguous and
 * PostgREST rejects the whole query with PGRST201.
 */
export const TIME_ENTRY_SELECT_WITH_STAFF =
  `${TIME_ENTRY_COLUMNS}, profiles!time_entries_staff_id_fkey(full_name)` as const;
