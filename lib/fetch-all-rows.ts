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
// "Every select" describes the problem, not the sweep that followed it: the
// first pass converted seven of the nine multi-row reads and left `equipment`
// and `equipment_usage_log` behind — the two the utilisation section and true
// cost per hour are computed from. All nine go through this now (the tenth
// select on the page, the viewer's own role, is a .single()). Anything added
// there must too: a comment claiming coverage is not coverage, which is how
// these two survived a change that named them.
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
  range: (
    from: number,
    to: number
  ) => PromiseLike<{ data: T[] | null; error: { message: string } | null; count?: number | null }>;
};

/**
 * Builds the query afresh for each page. A PostgREST builder is mutable —
 * range() rewrites its own offset and returns the same object — so pages
 * fetched at the same time cannot share one. Pass `count` straight through to
 * select(): it asks for the exact total on the first page only, which is what
 * lets the remaining pages be requested together instead of one after another.
 */
export type QueryFactory<T> = (count: { count?: "exact" }) => RangeableQuery<T>;

export type FetchAllResult<T> = { ok: true; rows: T[] } | { ok: false; error: string };

/**
 * Read every row a query matches, in pages.
 *
 * The first page carries the exact total, so every remaining page is requested
 * at once and reassembled in page order — the same rows, in the same order, as
 * reading them one by one. Without a total (a source that does not report one)
 * it falls back to paging one at a time until a short page.
 *
 * `maxPages` is a backstop, not a limit on your data: if the source keeps
 * returning full pages — a proxy that drops the Range header, a fake in a test,
 * a future PostgREST change — this errors rather than looping forever. Raise it
 * if a report legitimately grows past the default.
 */
export async function fetchAllRows<T>(
  build: QueryFactory<T>,
  pageSize = 1000,
  maxPages = 50
): Promise<FetchAllResult<T>> {
  const readPage = (page: number, count: { count?: "exact" } = {}) => {
    const from = page * pageSize;
    return build(count).range(from, from + pageSize - 1);
  };
  const failed = (page: number, message: string): FetchAllResult<T> =>
    // Deliberately discard what was collected. A partial sum is worse than no
    // sum, because it looks like a number and is quietly wrong.
    ({ ok: false, error: `Could not read all rows (page ${page + 1}): ${message}` });
  const tooManyPages: FetchAllResult<T> = {
    ok: false,
    error:
      `Reading this table did not terminate after ${maxPages} pages of ${pageSize} — ` +
      `too many pages, or the range header is being ignored. Refusing to report a partial total.`,
  };

  const first = await readPage(0, { count: "exact" });
  if (first.error) return failed(0, first.error.message);
  const rows: T[] = [...(first.data ?? [])];
  let lastBatch = first.data ?? [];
  let page = 1;

  const total = typeof first.count === "number" ? first.count : null;
  if (total !== null && lastBatch.length === pageSize) {
    const pageCount = Math.ceil(total / pageSize);
    if (pageCount > maxPages) return tooManyPages;
    const rest = await Promise.all(Array.from({ length: pageCount - 1 }, (_, i) => readPage(i + 1)));
    for (let i = 0; i < rest.length; i++) {
      const { data, error } = rest[i];
      if (error) return failed(i + 1, error.message);
      lastBatch = data ?? [];
      rows.push(...lastBatch);
    }
    page = pageCount;
    // The total settles where the table ends, so no confirming request. Only
    // if rows arrived after it was counted (the last page came back full and
    // past the total) does this carry on below, one page at a time.
    if (lastBatch.length < pageSize || rows.length <= total) return { ok: true, rows };
  }

  for (; page < maxPages; page++) {
    // A short page means the end. An exactly-full page might be the end too, so
    // one more request settles it rather than guessing.
    if (lastBatch.length < pageSize) return { ok: true, rows };
    const { data, error } = await readPage(page);
    if (error) return failed(page, error.message);
    lastBatch = data ?? [];
    rows.push(...lastBatch);
  }
  if (lastBatch.length < pageSize) return { ok: true, rows };

  return tooManyPages;
}
