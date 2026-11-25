import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// /api/jobs/[id]/mistakes and …/[mistakeId]/photos — the crew log a mistake
// (Justin, 25 Nov 2026: "crew raise, office costs"; migration 0119).
//
//   1. THE MONEY RULE (HANDOVER §2): the stages come from po_cost_centers
//      through the service role (it carries money); the categories, time
//      entries and the caller's mistakes through the caller. No answer may
//      carry a money-named key or an amount value, at any depth — even when
//      the rows read carry them.
//   2. The write is the CALLER's: raise_job_mistake() / add_job_mistake_photo()
//      run through callerClient, never the service role.
//   3. Errors are fixed sentences; before 0119 a "not switched on yet".

const requireOnJob = vi.fn();
vi.mock("@/lib/api/guards", () => ({ requireOnJob: (...a: unknown[]) => requireOnJob(...a) }));
vi.mock("@/lib/monitoring", () => ({ reportError: vi.fn() }));

const JOB = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const LINE = "11111111-1111-4111-8111-111111111111";
const CAT = "22222222-2222-4222-8222-222222222222";
const MISTAKE = "33333333-3333-4333-8333-333333333333";
const ENTRY = "44444444-4444-4444-8444-444444444444";
const ME = "66666666-6666-4666-8666-666666666666";
const AMOUNT = 4321.99;

let rpc: Record<string, { data: unknown; error: unknown }>;
let catsError: unknown = null;
const rpcCalls: [string, unknown][] = [];
const uploads: string[] = [];
const removed: string[] = [];

function chain(resolve: () => { data: unknown; error: unknown }) {
  const q: Record<string, unknown> = {};
  for (const m of ["select", "eq", "in", "order", "limit", "neq", "is"]) q[m] = () => q;
  q.maybeSingle = async () => resolve();
  q.then = (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => Promise.resolve(resolve()).then(ok, bad);
  return q;
}

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (t: string) =>
      chain(() =>
        t === "po_cost_centers"
          ? {
              data: [
                { id: LINE, name: "Drainage", sort_order: 1, completed_at: null, allocated_amount: AMOUNT, cost_centres: { name: "Below Ground" }, purchase_orders: { po_number: "9-1", total_value: AMOUNT }, profiles: null },
              ],
              error: null,
            }
          : { data: null, error: null }
      ),
    rpc: () => {
      throw new Error("the service role must never write a mistake");
    },
  }),
}));
vi.mock("@/lib/api/caller-client", () => ({
  callerClient: async () => ({
    from: (t: string) =>
      chain(() => {
        if (t === "mistake_categories") return { data: catsError ? null : [{ id: CAT, name: "Install error (rework)", sort_order: 1, rate: AMOUNT }], error: catsError };
        if (t === "time_entries") return { data: [{ id: ENTRY, clock_in: "2026-11-24T21:00:00Z", clock_out: "2026-11-25T01:00:00Z", hours: 4, rate_override: "1.5", amount: AMOUNT }], error: null };
        return { data: null, error: null };
      }),
    rpc: async (fn: string, args: unknown) => {
      rpcCalls.push([fn, args]);
      return rpc[fn] ?? { data: null, error: null };
    },
    storage: {
      from: () => ({
        upload: async (path: string) => {
          uploads.push(path);
          return { error: null };
        },
        remove: async (paths: string[]) => {
          removed.push(...paths);
          return { error: null };
        },
      }),
    },
  }),
}));

import { GET, POST } from "@/app/api/jobs/[id]/mistakes/route";
import { POST as PHOTO } from "@/app/api/jobs/[id]/mistakes/[mistakeId]/photos/route";

const params = { params: Promise.resolve({ id: JOB }) };
const req = (url: string, method: string, body?: unknown) =>
  new NextRequest(`http://localhost${url}`, {
    method,
    headers: { "content-type": "application/json", authorization: "Bearer t" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
const body = { id: MISTAKE, categoryId: CAT, causeCode: "install", costCenterId: LINE, description: "Pit too high", occurredOn: null, timeEntryIds: [ENTRY] };

const MONEY_KEY = /amount|value|price|rate|total|gst|margin|recover|claimed|^cost$/i;
function walk(v: unknown, path = "$"): string[] {
  const bad: string[] = [];
  if (typeof v === "number" && Math.abs(v - AMOUNT) < 0.001) bad.push(`${path} = ${v}`);
  if (v && typeof v === "object") {
    for (const [k, child] of Object.entries(v)) {
      if (MONEY_KEY.test(k)) bad.push(`${path}.${k}`);
      bad.push(...walk(child, `${path}.${k}`));
    }
  }
  return bad;
}

const myRow = {
  id: MISTAKE,
  job_id: JOB,
  occurred_on: "2026-11-25",
  category_name: "Install error (rework)",
  cause_code: "install",
  description: "Pit too high",
  status: "costed",
  stage_id: LINE,
  stage_name: "Drainage",
  raised_at: "2026-11-25T02:00:00Z",
  photo_count: 2,
  rework_entry_ids: [ENTRY],
  // A row that somehow carried money must still not leak it.
  recovered_ex_gst: AMOUNT,
  amount_ex_gst: AMOUNT,
};

beforeEach(() => {
  requireOnJob.mockReset();
  requireOnJob.mockResolvedValue({ ok: true, userId: ME, role: "technician" });
  rpc = { my_job_mistakes: { data: [myRow], error: null }, raise_job_mistake: { data: MISTAKE, error: null }, add_job_mistake_photo: { data: "p1", error: null } };
  catsError = null;
  rpcCalls.length = 0;
  uploads.length = 0;
  removed.length = 0;
});

describe("GET /api/jobs/[id]/mistakes", () => {
  it("answers the form and the caller's mistakes with no money", async () => {
    const res = await GET(req(`/api/jobs/${JOB}/mistakes`, "GET"), params);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ready).toBe(true);
    expect(json.categories).toEqual([{ id: CAT, name: "Install error (rework)" }]);
    expect(json.stages).toEqual([{ id: LINE, name: "Drainage", completed: false }]);
    expect(json.timeEntries).toEqual([{ id: ENTRY, clockIn: "2026-11-24T21:00:00Z", clockOut: "2026-11-25T01:00:00Z", hours: 4 }]);
    expect(json.mistakes[0]).toMatchObject({ id: MISTAKE, status: "costed", stageName: "Drainage", photoCount: 2, reworkEntryIds: [ENTRY] });
    expect(walk(json)).toEqual([]);
  });

  it("the money walk would catch an amount", () => {
    expect(walk({ a: { recovered_ex_gst: 1 } })).not.toEqual([]);
    expect(walk({ x: [AMOUNT] })).not.toEqual([]);
  });

  it("says not switched on before 0119", async () => {
    rpc.my_job_mistakes = { data: null, error: { code: "PGRST202", message: "no function" } };
    catsError = { code: "42P01", message: "no table" };
    const json = await (await GET(req(`/api/jobs/${JOB}/mistakes`, "GET"), params)).json();
    expect(json).toEqual({ ready: false, categories: [], stages: [], timeEntries: [], mistakes: [] });
  });

  it("refuses someone not on the job (the guard's answer)", async () => {
    requireOnJob.mockResolvedValue({ ok: false, response: new Response(JSON.stringify({ error: "This job isn't one of yours." }), { status: 403 }) });
    expect((await GET(req(`/api/jobs/${JOB}/mistakes`, "GET"), params)).status).toBe(403);
  });
});

describe("POST /api/jobs/[id]/mistakes", () => {
  it("raises it as the caller and answers with no money", async () => {
    const res = await POST(req(`/api/jobs/${JOB}/mistakes`, "POST", body), params);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.saved).toEqual({ id: MISTAKE });
    expect(rpcCalls[0]).toEqual([
      "raise_job_mistake",
      { p_id: MISTAKE, p_job_id: JOB, p_cost_center_id: LINE, p_category_id: CAT, p_cause_code: "install", p_description: "Pit too high", p_occurred_on: null, p_time_entry_ids: [ENTRY] },
    ]);
    expect(walk(json)).toEqual([]);
  });

  it("refuses a bad body before touching the database", async () => {
    const res = await POST(req(`/api/jobs/${JOB}/mistakes`, "POST", { ...body, causeCode: "bribery" }), params);
    expect(res.status).toBe(400);
    expect(rpcCalls).toEqual([]);
  });

  it("maps the database's refusals to fixed sentences, never its text", async () => {
    rpc.raise_job_mistake = { data: null, error: { code: "MJ130", message: "secret db text" } };
    const res = await POST(req(`/api/jobs/${JOB}/mistakes`, "POST", body), params);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "You can only mark your own time on this job as rework." });
    rpc.raise_job_mistake = { data: null, error: { code: "XX000", message: "secret db text" } };
    const r2 = await POST(req(`/api/jobs/${JOB}/mistakes`, "POST", body), params);
    expect(r2.status).toBe(500);
    expect(JSON.stringify(await r2.json())).not.toContain("secret");
    rpc.raise_job_mistake = { data: null, error: { code: "42883", message: "no fn" } };
    expect((await POST(req(`/api/jobs/${JOB}/mistakes`, "POST", body), params)).status).toBe(409);
  });
});

describe("POST …/mistakes/[mistakeId]/photos", () => {
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200)]).toString("base64");
  const pp = { params: Promise.resolve({ id: JOB, mistakeId: MISTAKE }) };

  it("uploads as the caller at the mistake's path and files it", async () => {
    const res = await PHOTO(req(`/api/jobs/${JOB}/mistakes/${MISTAKE}/photos`, "POST", { image: jpeg }), pp);
    expect(res.status).toBe(200);
    expect(uploads[0]).toMatch(new RegExp(`^${JOB}/mistakes/${MISTAKE}/\\d+\\.jpg$`));
    expect(rpcCalls[0]).toEqual(["add_job_mistake_photo", { p_mistake_id: MISTAKE, p_path: uploads[0] }]);
  });

  it("removes the file when the database refuses it", async () => {
    rpc.add_job_mistake_photo = { data: null, error: { code: "MJ124", message: "x" } };
    const res = await PHOTO(req(`/api/jobs/${JOB}/mistakes/${MISTAKE}/photos`, "POST", { image: jpeg }), pp);
    expect(res.status).toBe(409);
    expect(removed).toEqual(uploads);
  });

  it("refuses something that isn't a picture", async () => {
    const res = await PHOTO(req(`/api/jobs/${JOB}/mistakes/${MISTAKE}/photos`, "POST", { image: Buffer.alloc(300).toString("base64") }), pp);
    expect(res.status).toBe(400);
    expect(uploads).toEqual([]);
  });
});
