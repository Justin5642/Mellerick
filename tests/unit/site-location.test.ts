import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// "Set site location here" moves a site's pin through the service role, so:
// nobody unauthenticated, only a good fix, and only the crew on the job (or
// the office).

const requireUser = vi.fn();
const adminConstructed = vi.fn();
const updates: Record<string, unknown>[] = [];
let job: Record<string, unknown> | null = null;
let crewRow: unknown = null;

vi.mock("@/lib/api/guards", () => ({ requireUser: (...a: unknown[]) => requireUser(...a) }));
vi.mock("@/lib/monitoring", () => ({ reportError: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: vi.fn(() => {
    adminConstructed();
    return {
      from: (table: string) => {
        const chain: Record<string, unknown> = {};
        chain.select = () => chain;
        chain.eq = () => chain;
        chain.maybeSingle = async () => ({ data: table === "jobs" ? job : crewRow, error: null });
        chain.update = (patch: Record<string, unknown>) => {
          updates.push(patch);
          return { eq: async () => ({ error: null }) };
        };
        return chain;
      },
    };
  }),
}));

import { POST } from "@/app/api/jobs/[id]/site-location/route";

const call = (body: unknown) =>
  POST(new NextRequest("http://localhost/x", { method: "POST", body: JSON.stringify(body) }), { params: Promise.resolve({ id: "job-1" }) });
const HERE = { lat: -37.81, lng: 144.96, accuracy: 8 };

beforeEach(() => {
  vi.clearAllMocks();
  updates.length = 0;
  job = { id: "job-1", site_id: "site-1", assigned_to: "tech-1" };
  crewRow = null;
});

describe("POST site-location", () => {
  it("refuses an unauthenticated caller before touching the database", async () => {
    requireUser.mockResolvedValue({ ok: false, response: new Response("{}", { status: 401 }) });
    expect((await call(HERE)).status).toBe(401);
    expect(adminConstructed).not.toHaveBeenCalled();
  });

  it("pins the site for the tech on the job, recording who and when", async () => {
    requireUser.mockResolvedValue({ ok: true, userId: "tech-1", role: "technician" });
    expect((await call(HERE)).status).toBe(200);
    expect(updates[0]).toMatchObject({ site_lat: -37.81, site_lng: 144.96, location_set_by: "tech-1" });
  });

  it("refuses a vague fix", async () => {
    requireUser.mockResolvedValue({ ok: true, userId: "tech-1", role: "technician" });
    const res = await call({ ...HERE, accuracy: 120 });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/±120 m/);
    expect(updates).toHaveLength(0);
  });

  it("refuses someone not on the job, but lets the crew and the office", async () => {
    requireUser.mockResolvedValue({ ok: true, userId: "other", role: "technician" });
    expect((await call(HERE)).status).toBe(403);
    crewRow = { job_id: "job-1" };
    expect((await call(HERE)).status).toBe(200);
    crewRow = null;
    requireUser.mockResolvedValue({ ok: true, userId: "office-1", role: "office" });
    expect((await call(HERE)).status).toBe(200);
  });
});
