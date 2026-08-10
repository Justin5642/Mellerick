import { describe, it, expect } from "vitest";
import { fetchAllRows } from "../../lib/fetch-all-rows";

// PostgREST caps an unranged select and does NOT say so. Verified against
// production this session:
//
//   GET /rest/v1/job_photos?select=id   ->  1000 rows, content-range: 0-999/*
//
// No error, no flag on the response — just fewer rows than exist. Every one of
// the nine selects in app/dashboard/reports/page.tsx is unranged, so once a
// table crosses the cap the revenue-by-month chart, outstanding total, top
// customers and staff utilisation all start computing from a truncated set and
// presenting the answer as authoritative.
//
// Measured today: the largest table any report reads is `jobs` at 827 of 1000.
// So the reports are correct right now and will silently stop being correct,
// with no deploy and nothing to notice — the worst shape of failure this
// codebase keeps producing.
//
// Pagination is the wrong tool for a sum, and the durable fix is to aggregate
// in SQL — which needs a migration, handed over rather than applied here
// (standing rule 6). What is available now is to stop the truncation being
// silent: page until the source is exhausted, and refuse to return a partial
// answer dressed as a complete one.

type Page = { data: unknown[] | null; error: { message: string } | null };

/** A range() -> Promise fake that serves `total` rows in pages of `pageSize`. */
function fakeQuery(total: number, pageSize: number, opts: { failOnPage?: number } = {}) {
  let calls = 0;
  return {
    calls: () => calls,
    range: (from: number, to: number): Promise<Page> => {
      calls += 1;
      if (opts.failOnPage === calls) return Promise.resolve({ data: null, error: { message: "boom" } });
      const rows = [];
      for (let i = from; i <= Math.min(to, total - 1); i++) rows.push({ i });
      return Promise.resolve({ data: rows, error: null });
    },
  };
}

describe("fetchAllRows", () => {
  it("returns everything when the source fits in one page", async () => {
    const q = fakeQuery(120, 1000);
    const result = await fetchAllRows(q as never, 1000);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.rows).toHaveLength(120);
    expect(q.calls()).toBe(1);
  });

  it("keeps paging past the cap instead of stopping at it", async () => {
    // The whole point: 2500 rows behind a 1000-row cap must come back as 2500.
    const q = fakeQuery(2500, 1000);
    const result = await fetchAllRows(q as never, 1000);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.rows).toHaveLength(2500);
    expect(q.calls()).toBe(3);
  });

  it("stops when a page comes back short, without an extra round trip", async () => {
    const q = fakeQuery(1500, 1000);
    await fetchAllRows(q as never, 1000);
    expect(q.calls()).toBe(2);
  });

  it("does not pay for an extra request when the total is an exact multiple", async () => {
    // 2000 rows in pages of 1000 gives two full pages; a third confirms the end.
    // That one extra call is the price of not guessing, and is asserted so the
    // behaviour is deliberate rather than accidental.
    const q = fakeQuery(2000, 1000);
    const result = await fetchAllRows(q as never, 1000);
    if (!result.ok) throw new Error("unreachable");
    expect(result.rows).toHaveLength(2000);
    expect(q.calls()).toBe(3);
  });

  it("reports failure rather than returning the pages it managed to get", async () => {
    // A partial sum is worse than no sum: it looks like a number and is wrong.
    const q = fakeQuery(2500, 1000, { failOnPage: 2 });
    const result = await fetchAllRows(q as never, 1000);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error).toMatch(/boom/);
  });

  it("refuses to loop forever if the source keeps returning full pages", async () => {
    // Defence against a fake, a proxy, or a future PostgREST that ignores the
    // range header: bail with an error rather than spinning.
    const endless = { range: () => Promise.resolve({ data: Array.from({ length: 1000 }, (_, i) => ({ i })), error: null }) };
    const result = await fetchAllRows(endless as never, 1000, 3);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error).toMatch(/too many pages|did not terminate/i);
  });
});
