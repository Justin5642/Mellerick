import { chunkIds, mergeResults, readAllPages } from "./pagedRows";

// A source capped at `cap` rows per request, like PostgREST's max_rows.
function source(total: number, cap = 1000) {
  const ranges: [number, number][] = [];
  const rows = Array.from({ length: total }, (_, i) => ({ id: i }));
  const page = (from: number, to: number) => {
    ranges.push([from, to]);
    return Promise.resolve({ data: rows.slice(from, Math.min(to + 1, from + cap)), error: null });
  };
  return { page, ranges };
}

describe("readAllPages", () => {
  it("reads every row past the 1000-row cap, in order", async () => {
    const { page, ranges } = source(2345);
    const res = await readAllPages(page);
    expect(res.error).toBeNull();
    expect(res.data).toHaveLength(2345);
    expect(res.data?.[1500]).toEqual({ id: 1500 });
    expect(ranges).toEqual([
      [0, 999],
      [1000, 1999],
      [2000, 2999],
    ]);
  });

  it("asks once more after an exactly full page, then stops", async () => {
    const { page, ranges } = source(1000);
    expect((await readAllPages(page)).data).toHaveLength(1000);
    expect(ranges).toHaveLength(2);
  });

  it("returns the first error as it came (code kept), and no partial rows", async () => {
    let n = 0;
    const res = await readAllPages(() =>
      Promise.resolve(n++ === 0 ? { data: Array.from({ length: 1000 }, () => ({})), error: null } : { data: null, error: { message: "gone", code: "PGRST205" } })
    );
    expect(res).toEqual({ data: null, error: { message: "gone", code: "PGRST205" } });
  });

  it("refuses to loop forever on a source that ignores the range", async () => {
    const res = await readAllPages(() => Promise.resolve({ data: [1, 2], error: null }), 2, 3);
    expect(res.data).toBeNull();
    expect(res.error?.message).toMatch(/did not finish/);
  });
});

describe("chunkIds / mergeResults", () => {
  it("splits ids into chunks of 100", () => {
    const ids = Array.from({ length: 205 }, (_, i) => `id${i}`);
    expect(chunkIds(ids).map((c) => c.length)).toEqual([100, 100, 5]);
    expect(chunkIds([])).toEqual([]);
  });

  it("joins chunk answers; any error wins", () => {
    expect(mergeResults([{ data: [1], error: null }, { data: [2, 3], error: null }])).toEqual({ data: [1, 2, 3], error: null });
    expect(mergeResults([{ data: [1], error: null }, { data: null, error: { message: "x" } }]).data).toBeNull();
  });
});
