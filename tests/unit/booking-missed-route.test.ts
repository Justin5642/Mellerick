import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";

// /api/jobs/[id]/bookings/[bookingId]/missed — "Didn't make it" (27 Nov 2026,
// migration 0121).
//   1. requireRole with every staff role (requireUser leaves the role null).
//   2. The write is the CALLER's — callerClient's rpc, never the service role.
//   3. The booking must be on the job in the URL.
//   4. The database's codes become fixed sentences; its text never leaks.
//   5. Before 0121: a fixed "isn't switched on yet".

const requireRole = vi.fn();
vi.mock("@/lib/api/guards", () => ({ requireRole: (...a: unknown[]) => requireRole(...a) }));
vi.mock("@/lib/monitoring", () => ({ reportError: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => {
    throw new Error("the service role must never be used here");
  },
}));

const JOB = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_JOB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const BOOKING = "44444444-4444-4444-8444-444444444444";
const ME = "66666666-6666-4666-8666-666666666666";

let bookingRow: { id: string; job_id: string } | null;
let rpcResult: { data: unknown; error: unknown };
const rpcCalls: [string, unknown][] = [];

vi.mock("@/lib/api/caller-client", () => ({
  callerClient: async () => ({
    from: () => {
      const q: Record<string, unknown> = {};
      q.select = () => q;
      q.eq = () => q;
      q.maybeSingle = async () => ({ data: bookingRow, error: null });
      return q;
    },
    rpc: async (fn: string, args: unknown) => {
      rpcCalls.push([fn, args]);
      return rpcResult;
    },
  }),
}));

import { DELETE, POST } from "@/app/api/jobs/[id]/bookings/[bookingId]/missed/route";

const params = { params: Promise.resolve({ id: JOB, bookingId: BOOKING }) };
const req = (method: string, body?: unknown) =>
  new NextRequest(`http://localhost/api/jobs/${JOB}/bookings/${BOOKING}/missed`, {
    method,
    headers: { "content-type": "application/json", authorization: "Bearer t" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

const flagged = { id: BOOKING, job_id: JOB, staff_id: ME, missed_at: "2026-11-27T01:00:00Z", missed_reason: "weather", missed_note: null, updated_at: "x", google_event_id: "g" };

beforeEach(() => {
  requireRole.mockReset();
  requireRole.mockResolvedValue({ ok: true, userId: ME, role: "technician" });
  bookingRow = { id: BOOKING, job_id: JOB };
  rpcResult = { data: flagged, error: null };
  rpcCalls.length = 0;
});

describe("POST — flag", () => {
  it("guards with requireRole for every staff role", async () => {
    await POST(req("POST", { reason: "weather" }), params);
    expect(requireRole).toHaveBeenCalledWith(expect.anything(), ["admin", "office", "technician"]);
  });

  it("refuses when the guard refuses", async () => {
    requireRole.mockResolvedValue({ ok: false, response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) });
    const res = await POST(req("POST", { reason: "weather" }), params);
    expect(res.status).toBe(401);
    expect(rpcCalls).toHaveLength(0);
  });

  it("calls flag_booking_missed as the caller and answers only the flag's fields", async () => {
    const res = await POST(req("POST", { reason: "weather", note: "  rained out " }), params);
    expect(res.status).toBe(200);
    expect(rpcCalls).toEqual([["flag_booking_missed", { p_booking: BOOKING, p_reason: "weather", p_note: "rained out" }]]);
    const body = await res.json();
    expect(Object.keys(body.booking).sort()).toEqual(["id", "job_id", "missed_at", "missed_note", "missed_reason", "staff_id"]);
  });

  it("checks the reason and note before calling the database", async () => {
    for (const bad of [{}, { reason: "lunch" }, { reason: "other" }, { reason: "other", note: "  " }, { reason: "weather", note: "x".repeat(501) }]) {
      const res = await POST(req("POST", bad), params);
      expect(res.status).toBe(400);
    }
    expect(rpcCalls).toHaveLength(0);
  });

  it("Other with a note is fine", async () => {
    const res = await POST(req("POST", { reason: "other", note: "truck broke down" }), params);
    expect(res.status).toBe(200);
  });

  it("refuses a booking that isn't on this job", async () => {
    bookingRow = { id: BOOKING, job_id: OTHER_JOB };
    const res = await POST(req("POST", { reason: "weather" }), params);
    expect(res.status).toBe(404);
    expect(rpcCalls).toHaveLength(0);
  });

  it("refuses a booking the caller can't see", async () => {
    bookingRow = null;
    const res = await POST(req("POST", { reason: "weather" }), params);
    expect(res.status).toBe(404);
  });

  it.each([
    ["MJ142", 403],
    ["MJ143", 404],
    ["MJ144", 400],
    ["MJ145", 400],
    ["MJ001", 400],
    ["MJ147", 400],
    ["42883", 409],
    ["PGRST202", 409],
    ["XX000", 500],
  ])("maps %s to a fixed sentence (%i)", async (code, status) => {
    const secret = "relation job_bookings internals leaked";
    rpcResult = { data: null, error: { code, message: secret } };
    const res = await POST(req("POST", { reason: "weather" }), params);
    expect(res.status).toBe(status);
    const body = await res.json();
    expect(JSON.stringify(body)).not.toContain(secret);
    expect(typeof body.error).toBe("string");
  });

  it("before 0121: says it isn't switched on yet", async () => {
    rpcResult = { data: null, error: { code: "PGRST202", message: "Could not find the function" } };
    const res = await POST(req("POST", { reason: "weather" }), params);
    expect((await res.json()).error).toMatch(/isn't switched on yet/);
  });

  it("{ clear: true } clears (the phone's outbox only POSTs)", async () => {
    await POST(req("POST", { clear: true }), params);
    expect(rpcCalls).toEqual([["clear_booking_missed", { p_booking: BOOKING }]]);
  });
});

describe("DELETE — clear", () => {
  it("calls clear_booking_missed as the caller", async () => {
    const res = await DELETE(req("DELETE"), params);
    expect(res.status).toBe(200);
    expect(rpcCalls).toEqual([["clear_booking_missed", { p_booking: BOOKING }]]);
  });

  it("refuses a bad booking id", async () => {
    const res = await DELETE(req("DELETE"), { params: Promise.resolve({ id: JOB, bookingId: "nope" }) });
    expect(res.status).toBe(400);
    expect(rpcCalls).toHaveLength(0);
  });
});
