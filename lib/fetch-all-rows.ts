// PostgREST caps an unranged select and does not tell you.
//
// Verified against production:
//
//   GET /rest/v1/job_photos?select=id  ->  1000 rows, content-range: 0-999/*
//
// No error, no flag — just fewer rows than exist. Every select in
// app/dashboard/reports/page.tsx was unranged, so once a table crosses the cap
// the revenue-by-month chart, the outstanding total, top customers and staff
// utilisation all begin computing from a truncated set and presenting the
// result as authoritative.
//
// Measured when this was written: the largest table any report reads is `jobs`
// at 827 of 1000. The reports are correct today and will silently stop being
// correct, with no deploy and nothing to notice.
//
// Aggregating in SQL is the right long-term answer — pagination is the wrong
// tool for a sum — but that needs a migration, which is handed over rather than
// applied from here (HANDOVER-HARDENING.md standing rule 6). Until then: page
// until the source is exhausted, and never hand back a partial answer that
// looks like a complete one.

/** The shape this needs from a PostgREST query builder. */
export type RangeableQuery<T> = {
  range: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>;
};

export type FetchAllResult<T> = { ok: true; rows: T[] } | { ok: false; error: string };

/**
 * Read every row a query matches, in pages.
 *
 * `maxPages` is a backstop, not a limit on your data: if the source keeps
 * returning full pages — a proxy that drops the Range header, a fake in a test,
 * a future PostgREST change — this errors rather than looping forever. Raise it
 * if a report legitimately grows past the default.
 */
export async function fetchAllRows<T>(
  query: RangeableQuery<T>,
  pageSize = 1000,
  maxPages = 50
): Promise<FetchAllResult<T>> {
  const rows: T[] = [];

  for (let page = 0; page < maxPages; page++) {
    const from = page * pageSize;
    const { data, error } = await query.range(from, from + pageSize - 1);

    if (error) {
      // Deliberately discard what was collected. A partial sum is worse than no
      // sum, because it looks like a number and is quietly wrong.
      return { ok: false, error: `Could not read all rows (page ${page + 1}): ${error.message}` };
    }

    const batch = data ?? [];
    rows.push(...batch);

    // A short page means the end. An exactly-full page might be the end too, so
    // one more request settles it rather than guessing.
    if (batch.length < pageSize) return { ok: true, rows };
  }

  return {
    ok: false,
    error:
      `Reading this table did not terminate after ${maxPages} pages of ${pageSize} — ` +
      `too many pages, or the range header is being ignored. Refusing to report a partial total.`,
  };
}
