import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { parseLoadCostBody, parseQuarryBody, parseVoidBody, quarryChoiceOf, quarryValueOf } from "@/lib/day-works-office";

// The office's Day Works actions as routes (19 Nov 2026), so the phone can do
// them with its Bearer token: void a signed Day Works line, void a signed truck
// load, a load's docket cost + margin, and the job's quarry default.
//
// What matters:
//   1. Office/admin only — the guard runs first and a refusal touches nothing.
//   2. Every write uses the CALLER's client (RLS + 0108/0111's triggers), never
//      the service role.
//   3. Only a signed line/load is voided; an invoiced one must come off its
//      invoice first; the cost is refused once the load is invoiced or void.

const requireOfficeOrAdmin = vi.fn();
vi.mock("@/lib/api/guards", () => ({ requireOfficeOrAdmin: (...a: unknown[]) => requireOfficeOrAdmin(...a) }));
vi.mock("@/lib/monitoring", () => ({ reportError: vi.fn() }));
const loadTruckLoads = vi.fn();
vi.mock("@/lib/cartage-load", () => ({ loadTruckLoads: (...a: unknown[]) => loadTruckLoads(...a) }));
const loadDayWorks = vi.fn();
vi.mock("@/lib/day-works-load", () => ({ loadDayWorks: (...a: unknown[]) => loadDayWorks(...a) }));
const createAdminClient = vi.fn();
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => createAdminClient() }));

const JOB = "11111111-1111-4111-8111-111111111111";
const ROW = "33333333-3333-4333-8333-333333333333";

type Call = [string, unknown[]];
interface Query {
  table: string;
  calls: Call[];
}
const queries: Query[] = [];
let rowStatus: string | null = "signed";
let writeError: { code: string; message: string } | null = null;
let writeCount = 1;

const method = (q: Query) => q.calls.find(([m]) => ["insert", "update", "delete", "upsert"].includes(m))?.[0] ?? "select";
const writes = () => queries.filter((q) => method(q) !== "select");

function fakeClient() {
  return {
    from(table: string) {
      const q: Query = { table, calls: [] };
      queries.push(q);
      const chain: Record<string, unknown> = {};
      for (const m of ["select", "eq", "in", "update", "upsert", "insert", "delete", "maybeSingle"]) {
        chain[m] = (...a: unknown[]) => {
          q.calls.push([m, a]);
          return chain;
        };
      }
      chain.then = (ok: (v: unknown) => unknown, bad: (e: unknown) => unknown) => {
        const m = method(q);
        const result =
          m === "select"
            ? { data: rowStatus ? { id: ROW, status: rowStatus } : null, error: null }
            : { data: null, error: writeError, count: writeError ? null : writeCount };
        return Promise.resolve(result).then(ok, bad);
      };
      return chain;
    },
  };
}
vi.mock("@/lib/api/caller-client", () => ({ callerClient: async () => fakeClient() }));

import { POST as voidEntry } from "@/app/api/jobs/[id]/hire-entries/[entryId]/void/route";
import { POST as voidLoad } from "@/app/api/jobs/[id]/cartage-loads/[loadId]/void/route";
import { PUT as putCost } from "@/app/api/jobs/[id]/cartage-loads/[loadId]/cost/route";
import { PUT as putQuarry } from "@/app/api/jobs/[id]/cartage-loads/quarry/route";

const req = (body: unknown) => new NextRequest("http://test.local/x", { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } });
const entryCtx = { params: Promise.resolve({ id: JOB, entryId: ROW }) };
const loadCtx = { params: Promise.resolve({ id: JOB, loadId: ROW }) };
const jobCtx = { params: Promise.resolve({ id: JOB }) };

beforeEach(() => {
  vi.clearAllMocks();
  queries.length = 0;
  rowStatus = "signed";
  writeError = null;
  writeCount = 1;
  requireOfficeOrAdmin.mockResolvedValue({ ok: true, userId: "office-1", role: "office" });
  loadTruckLoads.mockResolvedValue({ ready: true, isOffice: true, loads: [] });
  loadDayWorks.mockResolvedValue({ ready: true, isOffice: true, entries: [] });
  createAdminClient.mockImplementation(() => {
    throw new Error("the service role must not be used for these writes");
  });
});

describe("body rules", () => {
  it("void reason: trimmed, blank = none, not too long, words only", () => {
    expect(parseVoidBody({ reason: "  wrong machine " })).toEqual({ ok: true, reason: "wrong machine" });
    expect(parseVoidBody({ reason: "   " })).toEqual({ ok: true, reason: null });
    expect(parseVoidBody(null)).toEqual({ ok: true, reason: null });
    expect(parseVoidBody({ reason: 5 }).ok).toBe(false);
    expect(parseVoidBody({ reason: "x".repeat(501) }).ok).toBe(false);
  });

  it("docket cost and margin: numbers or numeric text, blank = null, never negative, margin ≤ 1000 %", () => {
    expect(parseLoadCostBody({ docket_cost_ex_gst: "181.134", margin_pct: "" })).toEqual({ ok: true, docketCost: 181.13, marginPct: null });
    expect(parseLoadCostBody({ docket_cost_ex_gst: 90, margin_pct: 17.5 })).toEqual({ ok: true, docketCost: 90, marginPct: 17.5 });
    expect(parseLoadCostBody({ docket_cost_ex_gst: "12,5" })).toEqual({ ok: true, docketCost: 12.5, marginPct: null });
    expect(parseLoadCostBody({ docket_cost_ex_gst: -1 }).ok).toBe(false);
    expect(parseLoadCostBody({ margin_pct: 1001 }).ok).toBe(false);
    expect(parseLoadCostBody({ docket_cost_ex_gst: "abc" }).ok).toBe(false);
    expect(parseLoadCostBody({ docket_cost_ex_gst: {} }).ok).toBe(false);
  });

  it("quarry default: true, false or null only", () => {
    expect(parseQuarryBody({ quarry_included: false })).toEqual({ ok: true, quarryIncluded: false });
    expect(parseQuarryBody({ quarry_included: null })).toEqual({ ok: true, quarryIncluded: null });
    expect(parseQuarryBody({}).ok).toBe(false);
    expect(parseQuarryBody({ quarry_included: "extra" }).ok).toBe(false);
    expect(quarryChoiceOf(false)).toBe("extra");
    expect(quarryChoiceOf(null)).toBe("default");
    expect(quarryValueOf("included")).toBe(true);
    expect(quarryValueOf("default")).toBeNull();
  });
});

describe("office-only", () => {
  it("each route answers the guard's refusal and touches nothing", async () => {
    requireOfficeOrAdmin.mockResolvedValue({ ok: false, response: new Response(JSON.stringify({ error: "Insufficient permissions" }), { status: 403 }) });
    expect((await voidEntry(req({}), entryCtx)).status).toBe(403);
    expect((await voidLoad(req({}), loadCtx)).status).toBe(403);
    expect((await putCost(req({ docket_cost_ex_gst: 5 }), loadCtx)).status).toBe(403);
    expect((await putQuarry(req({ quarry_included: false }), jobCtx)).status).toBe(403);
    expect(queries).toHaveLength(0);
  });
});

describe("void", () => {
  it("voids a signed Day Works line with the caller's client and answers with the office's tab", async () => {
    const res = await voidEntry(req({ reason: " wrong day " }), entryCtx);
    expect(res.status).toBe(200);
    const w = writes();
    expect(w).toHaveLength(1);
    expect(w[0].table).toBe("hire_entries");
    expect(w[0].calls.find(([m]) => m === "update")![1][0]).toEqual({ status: "void", void_reason: "wrong day" });
    expect(w[0].calls).toContainEqual(["eq", ["status", "signed"]]);
    expect(w[0].calls).toContainEqual(["eq", ["job_id", JOB]]);
    expect(loadDayWorks).toHaveBeenCalledWith(expect.anything(), JOB, { userId: "office-1", isOffice: true });
  });

  it("voids a signed truck load", async () => {
    const res = await voidLoad(req({}), loadCtx);
    expect(res.status).toBe(200);
    expect(writes()[0].table).toBe("cartage_loads");
    expect(writes()[0].calls.find(([m]) => m === "update")![1][0]).toEqual({ status: "void", void_reason: null });
    expect(loadTruckLoads).toHaveBeenCalled();
  });

  it("an invoiced one must come off its invoice; a draft is deleted, not voided; a missing one is 404", async () => {
    rowStatus = "invoiced";
    expect((await voidLoad(req({}), loadCtx)).status).toBe(409);
    rowStatus = "draft";
    expect((await voidEntry(req({}), entryCtx)).status).toBe(409);
    rowStatus = null;
    expect((await voidEntry(req({}), entryCtx)).status).toBe(404);
    expect(writes()).toHaveLength(0);
  });

  it("a row that changed meanwhile (0 updated) is a 409, and a database error a fixed sentence", async () => {
    writeCount = 0;
    expect((await voidLoad(req({}), loadCtx)).status).toBe(409);
    writeCount = 1;
    writeError = { code: "XX000", message: "secret internals" };
    const res = await voidEntry(req({}), entryCtx);
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain("secret internals");
  });
});

describe("docket cost", () => {
  it("upserts the cost for a load on this job with the caller's client", async () => {
    const res = await putCost(req({ docket_cost_ex_gst: "181.13", margin_pct: 20 }), loadCtx);
    expect(res.status).toBe(200);
    const w = writes();
    expect(w).toHaveLength(1);
    expect(w[0].table).toBe("cartage_load_costs");
    expect(w[0].calls.find(([m]) => m === "upsert")![1]).toEqual([{ load_id: ROW, docket_cost_ex_gst: 181.13, margin_pct: 20 }, { onConflict: "load_id" }]);
    const read = queries.find((q) => q.table === "cartage_loads")!;
    expect(read.calls).toContainEqual(["eq", ["job_id", JOB]]);
  });

  it("locked once the load is invoiced or void; bad numbers refused before any read", async () => {
    for (const s of ["invoiced", "void"]) {
      rowStatus = s;
      expect((await putCost(req({ docket_cost_ex_gst: 5 }), loadCtx)).status).toBe(409);
    }
    expect(writes()).toHaveLength(0);
    queries.length = 0;
    expect((await putCost(req({ docket_cost_ex_gst: -5 }), loadCtx)).status).toBe(400);
    expect(queries).toHaveLength(0);
  });

  it("a load signed, or still a draft, takes a cost (the office prices it before or after sign-off)", async () => {
    rowStatus = "draft";
    expect((await putCost(req({ docket_cost_ex_gst: 5 }), loadCtx)).status).toBe(200);
  });
});

describe("quarry default", () => {
  it("sets jobs.quarry_included with the caller's client", async () => {
    const res = await putQuarry(req({ quarry_included: false }), jobCtx);
    expect(res.status).toBe(200);
    const w = writes();
    expect(w[0].table).toBe("jobs");
    expect(w[0].calls.find(([m]) => m === "update")![1][0]).toEqual({ quarry_included: false });
    expect(w[0].calls).toContainEqual(["eq", ["id", JOB]]);
  });

  it("the trigger's refusal reads as office-only; an unknown job is 404", async () => {
    writeError = { code: "42501", message: "Only the office can set whether quarry product is included on a job." };
    expect((await putQuarry(req({ quarry_included: true }), jobCtx)).status).toBe(403);
    writeError = null;
    writeCount = 0;
    expect((await putQuarry(req({ quarry_included: true }), jobCtx)).status).toBe(404);
  });
});
