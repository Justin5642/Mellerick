// The REMOTE half of searchJobs — what a technician's Search tab asks Supabase
// on every debounced keystroke. It used to be `.limit(10000)` over the whole
// jobs table with customers and sites embedded, filtered in JS: megabytes per
// letter on a phone with one bar. These pin that the filtering now happens on
// the server and the response is capped.
const mockCalls: { table: string; method: string; args: unknown[] }[] = [];
let mockAnswers: Record<string, unknown> = {};

jest.mock("../../supabase", () => {
  function builder(table: string) {
    const b: Record<string, unknown> = {};
    for (const m of ["select", "eq", "or", "ilike", "order", "limit"]) {
      b[m] = (...args: unknown[]) => {
        mockCalls.push({ table, method: m, args });
        return b;
      };
    }
    b.then = (resolve: (v: unknown) => unknown) => resolve(mockAnswers[table] ?? { data: [], error: null });
    return b;
  }
  return { supabase: { from: (table: string) => builder(table) } };
});

import { resetSourceForTests } from "./source";
import { MIN_SEARCH_LENGTH, searchJobs } from "./jobs";

const callsOn = (table: string, method: string) =>
  mockCalls.filter((c) => c.table === table && c.method === method).map((c) => c.args);

afterEach(() => {
  resetSourceForTests();
  mockCalls.length = 0;
  mockAnswers = {};
});

describe("searchJobs (remote)", () => {
  it("never asks for more than 50 jobs — the old path pulled 10,000", async () => {
    await searchJobs("pump");
    expect(callsOn("jobs", "limit")).toEqual([[50]]);
  });

  it("filters on the server by title, and by customer/site via their ids", async () => {
    mockAnswers = {
      customers: { data: [{ id: "c1" }], error: null },
      sites: { data: [{ id: "s1" }, { id: "s2" }], error: null },
    };
    await searchJobs("acme");
    expect(callsOn("customers", "ilike")).toEqual([["name", "%acme%"]]);
    expect(callsOn("sites", "or")).toEqual([["name.ilike.%acme%,address_line1.ilike.%acme%,suburb.ilike.%acme%"]]);
    expect(callsOn("jobs", "or")).toEqual([["title.ilike.%acme%,customer_id.in.(c1),site_id.in.(s1,s2)"]]);
  });

  it("matches an all-digit query as an exact job number", async () => {
    await searchJobs("1042");
    expect(callsOn("jobs", "or")).toEqual([["title.ilike.%1042%,job_number.eq.1042"]]);
  });

  it("strips PostgREST's OR syntax out of the query instead of letting it reshape the filter", async () => {
    await searchJobs("a,b(c)");
    expect(callsOn("jobs", "or")).toEqual([["title.ilike.%a b c%"]]);
  });

  it(`asks nothing for a query shorter than ${MIN_SEARCH_LENGTH} characters`, async () => {
    await expect(searchJobs("a")).resolves.toEqual([]);
    await expect(searchJobs(" b ")).resolves.toEqual([]);
    expect(mockCalls).toEqual([]);
  });

  it("surfaces a failed customer lookup rather than quietly searching titles only", async () => {
    mockAnswers = { customers: { data: null, error: { message: "boom" } } };
    await expect(searchJobs("acme")).rejects.toThrow(/boom/);
  });

  it("returns the jobs rows as the screen's shape", async () => {
    const row = { id: "j1", job_number: 7, title: "Pump", status: "open", scheduled_start: null, customers: null, sites: null };
    mockAnswers = { jobs: { data: [row], error: null } };
    await expect(searchJobs("pump")).resolves.toEqual([row]);
  });
});
