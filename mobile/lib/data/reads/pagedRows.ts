// PostgREST answers at most 1000 rows per request (supabase/config.toml
// max_rows; the hosted project is the same) and says nothing when it stops:
// no error, just fewer rows than exist. The office Schedule tab's reads were
// single requests, so past 1000 jobs or bookings the phone silently dropped
// some — and different ones from the web board, which is one reason the two
// schedules disagreed (Justin, 24 Nov 2026). The web pages with
// lib/fetch-all-rows.ts; this is the phone's equivalent for remote reads.
//
// The caller builds the query afresh for each page (a PostgREST builder is
// mutable — range() rewrites its own offset) and MUST order by something
// unique (add .order("id") last), or pages can overlap and skip rows.
import type { SupabaseResult } from "./unwrap";

export const PAGE_SIZE = 1000;

/**
 * Every row, one page at a time until a short page. Answers in the same
 * shape as a single query, so callers keep their missing-table / unwrapRows
 * handling: the first error is returned as it came (code included), and
 * nothing collected before it — a partial list must never look complete.
 * `maxPages` is a backstop against a source that ignores the range.
 */
export async function readAllPages<T>(
  page: (from: number, to: number) => PromiseLike<SupabaseResult<T[]>>,
  pageSize = PAGE_SIZE,
  maxPages = 50
): Promise<SupabaseResult<T[]>> {
  const rows: T[] = [];
  for (let i = 0; i < maxPages; i++) {
    const from = i * pageSize;
    const { data, error } = await page(from, from + pageSize - 1);
    if (error) return { data: null, error };
    const batch = data ?? [];
    rows.push(...batch);
    if (batch.length < pageSize) return { data: rows, error: null };
  }
  return {
    data: null,
    error: { message: `Reading did not finish after ${maxPages} pages of ${pageSize} — refusing a partial list.` },
  };
}

/** Ids per `.in()` request, so the URL stays a sensible length (uuids are 36 characters). */
export const IN_CHUNK = 100;

export function chunkIds<T>(ids: readonly T[], size = IN_CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size));
  return out;
}

/** Several paged reads (one per chunk) as one answer: the first error wins. */
export function mergeResults<T>(results: readonly SupabaseResult<T[]>[]): SupabaseResult<T[]> {
  const rows: T[] = [];
  for (const { data, error } of results) {
    if (error) return { data: null, error };
    rows.push(...(data ?? []));
  }
  return { data: rows, error: null };
}
