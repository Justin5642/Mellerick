import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// /api/jobs/[id]/self-start — a technician starts work on a job they're not
// booked on (Justin, 25 Nov 2026; migration 0118).
//
// What matters, in order:
//   1. THE MONEY RULE (HANDOVER §2). The stages come from po_cost_centers
//      through the service role (it carries money). Neither answer may carry
//      a money-named key or an amount value, at any depth.
//   2. The write is the CALLER's: the database function runs through
//      callerClient, never the service role, and only for technicians.
//   3. The cost centre must be one of the job's OPEN stages; a closed job is
//      refused with 0096's sentence; a job with no stages can't be started.
//   4. Before 0118: a fixed "not switched on yet", never the database's text.

const requireRole = vi.fn();
vi.mock("@/lib/api/guards", () => ({ requireRole: (...a: unknown[]) => requireRole(...a) }));
vi.mock("@/lib/monitoring", () => ({ reportError: vi.fn() }));

const JOB = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const LINE_OPEN = "11111111-1111-4111-8111-111111111111";
const LINE_DONE = "22222222-2222-4222-8222-222222222222";
const LINE_OTHER = "33333333-3333-4333-8333-333333333333";
const BOOKING = "44444444-4444-4444-8444-444444444444";
const ENTRY = "55555555-5555-4555-8555-555555555555";
const ME = "66666666-6666-4666-8666-666666666666";
const ALLOCATED = 12345.67;

let jobRow: Record<string, unknown> | null;
let lines: Record<string, unknown>[];
let limited = false;
let rpcResult: { data: unknown; error: unknown };
const rpcCalls: [string, unknown][] = [];

function chain(table: string) {
  const resolve = () => {
    if (table === "jobs") return { data: jobRow, error: null };
    if (table === "profiles") return { data: { id: ME, role: "technician", limited_access: limited }, error: null };
    if (table === "po_cost_centers") return { data: lines, error: null };
    return { data: null, error: null };
  };
  const q: Record<string, unknown> = {};
  for (const m of ["select", "eq", "in", "order"]) q[m] = () => q;
  q.maybeSingle = async () => resolve();
  q.single = async () => resolve();
  q.then = (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => Promise.resolve(resolve()).then(ok, bad);
  return q;
}

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (t: string) => chain(t),
    rpc: () => {
      throw new Error("the service role must never make the booking");
    },
  }),
}));
vi.mock("@/lib/api/caller-client", () => ({
  callerClient: async () => ({
    rpc: async (fn: string, args: unknown) => {
      rpcCalls.push([fn, args]);
      return rpcResult;
    },
  }),
}));

import { GET, POST } from "@/app/api/jobs/[id]/self-start/route";

const params = { params: Promise.resolve({ id: JOB }) };
const req = (method: string, body?: unknown) =>
  new NextRequest(`http://localhost/api/jobs/${JOB}/self-start`, {
    method,
    headers: { "content-type": "application/json", authorization: "Bearer t" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
const body = { bookingId: BOOKING, costCenterId: LINE_OPEN, entryId: ENTRY };

const MONEY_KEY = /amount|value|price|rate|total|gst|margin|^cost$/i;
function walk(v: unknown, path = "$"): string[] {
  const bad: string[] = [];
  if (typeof v === "number" && Math.abs(v - ALLOCATED) < 0.001) bad.push(`${path} = ${v}`);
  if (v && typeof v === "object") {
    for (const [k, child] of Object.entries(v)) {
      if (MONEY_KEY.test(k)) bad.push(`${path}.${k}`);
      bad.push(...walk(child, `${path}.${k}`));
    }
  }
  return bad;
}

beforeEach(() => {
  requireRole.mockReset();
  requireRole.mockResolvedValue({ ok: true, userId: ME, role: "technician" });
  jobRow = { id: JOB, job_number: 123, title: "Lot 4", status: "pending", total_value: ALLOCATED };
  lines = [
    { id: LINE_OPEN, name: "Stage 2", sort_order: 1, completed_at: null, allocated_amount: ALLOCATED, cost_centres: { name: "Drainage" }, purchase_orders: { po_number: "123-1", total_value: ALLOCATED }, profiles: null },
    { id: LINE_DONE, name: "Rough in", sort_order: 0, completed_at: "2026-11-20T01:00:00Z", allocated_amount: ALLOCATED, cost_centres: null, purchase_orders: { po_number: "123-1" }, profiles: { full_name: "Dan" } },
  ];
  limited = false;
  rpcResult = {
    data: { id: BOOKING, job_id: JOB, staff_id: ME, cost_center_id: LINE_OPEN, starts_at: "2026-11-25T00:00:00Z", ends_at: null, daily: false, all_day: false, created_by: ME, clock_entry_id: ENTRY, google_event_id: "evt", note: null },
    error: null,
  };
  rpcCalls.length = 0;
});

describe("GET /api/jobs/[id]/self-start", () => {
  it("lists the job's stages by name with completion, and no money", async () => {
    const res = await GET(req("GET"), params);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.stages.map((s: { id: string }) => s.id)).toEqual([LINE_DONE, LINE_OPEN]);
    expect(json.stages[1]).toEqual({ id: LINE_OPEN, name: "Stage 2", costCentre: "Drainage", completedAt: null });
    expect(json.openCount).toBe(1);
    expect(json.job).toMatchObject({ jobNumber: 123, closed: false });
    expect(walk(json)).toEqual([]);
  });

  it("the money walk would catch an amount", () => {
    expect(walk({ a: { allocated_amount: 1 } })).toEqual(["$.a.allocated_amount"]);
    expect(walk({ n: ALLOCATED })).toEqual([`$.n = ${ALLOCATED}`]);
  });

  it("refuses a limited-access account", async () => {
    limited = true;
    expect((await GET(req("GET"), params)).status).toBe(403);
  });

  it("answers 404 for an unknown job", async () => {
    jobRow = null;
    expect((await GET(req("GET"), params)).status).toBe(404);
  });
});

describe("POST /api/jobs/[id]/self-start", () => {
  it("is for technicians only", async () => {
    await POST(req("POST", body), params);
    expect(requireRole.mock.calls[0][1]).toEqual(["technician"]);
  });

  it("makes the booking as the caller and answers its window and stage, no money", async () => {
    const res = await POST(req("POST", body), params);
    expect(res.status).toBe(200);
    expect(rpcCalls).toEqual([
      ["self_start_job_booking", { p_booking_id: BOOKING, p_job_id: JOB, p_cost_center_id: LINE_OPEN, p_entry_id: ENTRY }],
    ]);
    const json = await res.json();
    expect(json.booking).toMatchObject({ id: BOOKING, staff_id: ME, cost_center_id: LINE_OPEN, ends_at: null, created_by: ME });
    expect(json.booking.google_event_id).toBeUndefined();
    expect(json.stage).toEqual({ id: LINE_OPEN, name: "Stage 2", costCentre: "Drainage" });
    expect(walk(json)).toEqual([]);
  });

  it("refuses a completed stage, another job's line and a bad body before the database", async () => {
    expect((await POST(req("POST", { ...body, costCenterId: LINE_DONE }), params)).status).toBe(400);
    expect((await POST(req("POST", { ...body, costCenterId: LINE_OTHER }), params)).status).toBe(400);
    expect((await POST(req("POST", { ...body, entryId: "nope" }), params)).status).toBe(400);
    expect(rpcCalls).toEqual([]);
  });

  it("refuses a job with no open stage", async () => {
    lines = lines.filter((l) => l.id === LINE_DONE);
    const res = await POST(req("POST", { ...body, costCenterId: LINE_DONE }), params);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/Ask the office to add one/);
  });

  it("refuses a closed job with 0096's sentence", async () => {
    jobRow = { ...jobRow!, status: "completed" };
    const res = await POST(req("POST", body), params);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Job #123 is completed. A completed job can't be scheduled — reopen it first.");
    expect(rpcCalls).toEqual([]);
  });

  it("before 0118: a fixed sentence, never the database's text", async () => {
    rpcResult = { data: null, error: { code: "PGRST202", message: "Could not find the function public.self_start_job_booking" } };
    const res = await POST(req("POST", body), params);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/isn't switched on yet/);
  });

  it("maps the function's own refusals and hides anything else", async () => {
    rpcResult = { data: null, error: { code: "MJ115", message: "x" } };
    expect((await POST(req("POST", body), params)).status).toBe(400);
    rpcResult = { data: null, error: { code: "XX000", message: "secret internals" } };
    const res = await POST(req("POST", body), params);
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toMatch(/secret/);
  });

  it("refuses a limited-access account", async () => {
    limited = true;
    expect((await POST(req("POST", body), params)).status).toBe(403);
    expect(rpcCalls).toEqual([]);
  });
});
