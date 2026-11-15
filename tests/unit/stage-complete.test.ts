import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// A stage marked complete from site (0095). It writes an office-only table
// through the service role, so: nobody unauthenticated, only the crew on the
// job (or the office), only a stage of THIS job, and only the office reopens.
// Refusals must not be 404 — the phone's outbox retries a 404 forever.

const requireUser = vi.fn();
const updates: Record<string, unknown>[] = [];
let job: Record<string, unknown> | null = null;
let crewRow: unknown = null;
let stage: Record<string, unknown> | null = null;

vi.mock("@/lib/api/guards", () => ({ requireUser: (...a: unknown[]) => requireUser(...a) }));
vi.mock("@/lib/monitoring", () => ({ reportError: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: vi.fn(() => ({
    from: (table: string) => {
      const chain: Record<string, unknown> = {};
      for (const m of ["select", "eq", "is"]) chain[m] = () => chain;
      chain.maybeSingle = async () => ({
        data: table === "jobs" ? job : table === "job_assignments" ? crewRow : stage,
        error: null,
      });
      chain.update = (patch: Record<string, unknown>) => {
        updates.push(patch);
        const done = { eq: () => done, is: () => done, then: (r: (v: unknown) => unknown) => r({ error: null }) };
        return done;
      };
      return chain;
    },
  })),
}));

import { POST } from "@/app/api/jobs/[id]/stages/[stageId]/complete/route";

const call = (body: unknown = {}) =>
  POST(new NextRequest("http://localhost/x", { method: "POST", body: JSON.stringify(body) }), {
    params: Promise.resolve({ id: "job-1", stageId: "stage-1" }),
  });
const tech = (id = "tech-1") => ({ ok: true as const, userId: id, role: "technician" });

beforeEach(() => {
  vi.clearAllMocks();
  updates.length = 0;
  job = { id: "job-1", assigned_to: "tech-1" };
  crewRow = null;
  stage = { id: "stage-1", completed_at: null };
});

describe("POST stage complete", () => {
  it("refuses an unauthenticated caller", async () => {
    requireUser.mockResolvedValue({ ok: false, response: new Response("{}", { status: 401 }) });
    expect((await call()).status).toBe(401);
    expect(updates).toHaveLength(0);
  });

  it("refuses someone not on the job", async () => {
    requireUser.mockResolvedValue(tech("stranger"));
    expect((await call()).status).toBe(403);
    expect(updates).toHaveLength(0);
  });

  it("refuses a stage that isn't on this job, without a 404", async () => {
    requireUser.mockResolvedValue(tech());
    stage = null;
    expect((await call()).status).toBe(400);
  });

  it("marks it complete as the caller, at the time it was tapped", async () => {
    requireUser.mockResolvedValue(tech());
    const tapped = new Date(Date.now() - 3_600_000).toISOString();
    const res = await call({ completedAt: tapped });
    expect(await res.json()).toEqual({ completedAt: tapped });
    expect(updates[0]).toEqual({ completed_at: tapped, completed_by: "tech-1" });
  });

  it("ignores a tapped time in the future or weeks old", async () => {
    requireUser.mockResolvedValue(tech());
    await call({ completedAt: "2099-01-01T00:00:00Z" });
    expect(Date.parse(updates[0].completed_at as string)).toBeLessThanOrEqual(Date.now());
  });

  it("keeps the first stamp on a retry", async () => {
    requireUser.mockResolvedValue(tech());
    stage = { id: "stage-1", completed_at: "2026-11-04T05:00:00Z" };
    expect(await (await call()).json()).toEqual({ completedAt: "2026-11-04T05:00:00Z" });
    expect(updates).toHaveLength(0);
  });

  it("lets the office reopen a stage, but not the crew", async () => {
    stage = { id: "stage-1", completed_at: "2026-11-04T05:00:00Z" };
    requireUser.mockResolvedValue(tech());
    expect((await call({ reopen: true })).status).toBe(403);
    requireUser.mockResolvedValue({ ok: true, userId: "office-1", role: "office" });
    expect(await (await call({ reopen: true })).json()).toEqual({ completedAt: null });
    expect(updates[0]).toEqual({ completed_at: null, completed_by: null });
  });

  it("lets crew on the job (not the lead) complete it", async () => {
    requireUser.mockResolvedValue(tech("crew-2"));
    crewRow = { job_id: "job-1" };
    expect((await call()).status).toBe(200);
  });
});
