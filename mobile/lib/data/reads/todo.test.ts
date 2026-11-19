// The phone's to-do list reads (Schedule tab, office/admin): the list with
// its PO-hours fallback from the money-free purchase_orders_public view, and
// the "Add job…" search. A chainable fake records every builder call.
type Call = [string, ...unknown[]];
const results = new Map<string, { data: unknown; error: unknown } | Error>();
const calls: { table: string; chain: Call[] }[] = [];

function mockBuilder(table: string) {
  const chain: Call[] = [];
  calls.push({ table, chain });
  const b: Record<string, unknown> = {};
  for (const m of ["select", "not", "order", "in", "is", "eq", "or", "limit"]) {
    b[m] = (...args: unknown[]) => {
      chain.push([m, ...args]);
      return b;
    };
  }
  b.then = (resolve: (v: unknown) => void, reject: (e: unknown) => void) => {
    const r = results.get(table) ?? { data: [], error: null };
    return r instanceof Error ? Promise.reject(r).then(resolve, reject) : Promise.resolve(r).then(resolve, reject);
  };
  return b;
}
jest.mock("../../supabase", () => ({ supabase: { from: (t: string) => mockBuilder(t) } }));

import { isSearchable, listTodoJobs, searchTodoCandidates, searchTokens } from "./todo";

beforeEach(() => {
  results.clear();
  calls.length = 0;
});

const jobRow = (over: Record<string, unknown> = {}) => ({
  id: "j1",
  job_number: 123,
  title: "Sewer repair",
  priority: "high",
  status: "pending",
  todo_listed_at: "2026-11-10T00:00:00Z",
  estimated_hours: null,
  customers: { name: "Acme" },
  sites: { suburb: "Craigieburn" },
  ...over,
});

describe("listTodoJobs", () => {
  it("lists listed jobs and fills hours from purchase_orders_public for those without an estimate", async () => {
    results.set("jobs", { data: [jobRow(), jobRow({ id: "j2", job_number: 124, estimated_hours: "2.5" })], error: null });
    results.set("purchase_orders_public", { data: [{ job_id: "j1", total_hours: 3 }, { job_id: "j1", total_hours: "1.5" }], error: null });
    const jobs = await listTodoJobs();
    expect(jobs).toEqual([
      { id: "j1", job_number: 123, title: "Sewer repair", priority: "high", status: "pending", todo_listed_at: "2026-11-10T00:00:00Z", estimated_hours: null, po_allocated_hours: 4.5, customer_name: "Acme", suburb: "Craigieburn" },
      { id: "j2", job_number: 124, title: "Sewer repair", priority: "high", status: "pending", todo_listed_at: "2026-11-10T00:00:00Z", estimated_hours: 2.5, po_allocated_hours: null, customer_name: "Acme", suburb: "Craigieburn" },
    ]);
    const po = calls.find((c) => c.table === "purchase_orders_public")!;
    expect(po.chain).toContainEqual(["select", "job_id, total_hours"]); // hours only — never a value column
    expect(po.chain).toContainEqual(["in", "job_id", ["j1"]]);
    expect(calls.some((c) => c.table === "purchase_orders")).toBe(false);
  });

  it("still lists the jobs when the PO hours can't be read", async () => {
    results.set("jobs", { data: [jobRow()], error: null });
    results.set("purchase_orders_public", new Error("Network request failed"));
    expect((await listTodoJobs())[0].po_allocated_hours).toBeNull();
  });

  it("throws when the list itself can't be read (never an empty list)", async () => {
    results.set("jobs", { data: null, error: { message: "boom" } });
    await expect(listTodoJobs()).rejects.toThrow("boom");
  });
});

describe("searchTodoCandidates", () => {
  it("needs two characters or a job number", () => {
    expect(isSearchable("a")).toBe(false);
    expect(isSearchable("7")).toBe(true);
    expect(isSearchable("ab")).toBe(true);
    expect(searchTokens('smith, (acme)"')).toEqual(["smith", "acme"]);
  });

  it("finds a job by number among open, unscheduled, unlisted jobs", async () => {
    results.set("jobs", { data: [jobRow({ todo_listed_at: null, scheduled_start: null })], error: null });
    const found = await searchTodoCandidates("#123");
    expect(found).toEqual([{ id: "j1", job_number: 123, title: "Sewer repair", status: "pending", priority: "high", estimated_hours: null, customer_name: "Acme", suburb: "Craigieburn" }]);
    const chain = calls[0].chain;
    expect(chain).toContainEqual(["in", "status", ["pending", "on_hold"]]);
    expect(chain).toContainEqual(["is", "todo_listed_at", null]);
    expect(chain).toContainEqual(["is", "scheduled_start", null]);
    expect(chain).toContainEqual(["eq", "job_number", 123]);
  });

  it("matches every word in the title or the customer's name, and drops anything already listed or scheduled", async () => {
    results.set("customers", { data: [{ id: "c1" }], error: null });
    results.set("jobs", {
      data: [
        jobRow({ todo_listed_at: null, scheduled_start: null }),
        jobRow({ id: "j9", todo_listed_at: null, scheduled_start: "2026-11-20T00:00:00Z" }),
        jobRow({ id: "j8", status: "in_progress", todo_listed_at: null, scheduled_start: null }),
      ],
      error: null,
    });
    const found = await searchTodoCandidates("acme sewer");
    expect(found.map((j) => j.id)).toEqual(["j1"]);
    const jobs = calls.find((c) => c.table === "jobs")!;
    expect(jobs.chain.filter((c) => c[0] === "or")).toEqual([
      ["or", "title.ilike.%acme%,customer_id.in.(c1)"],
      ["or", "title.ilike.%sewer%,customer_id.in.(c1)"],
    ]);
  });

  it("throws on a failed search", async () => {
    results.set("jobs", { data: null, error: { message: "offline" } });
    await expect(searchTodoCandidates("123")).rejects.toThrow("offline");
  });
});
