import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// The crew's Delivered tap (Stage 4, 0089). It reaches office-only
// vendor_orders through the service role, so: nobody unauthenticated, only an
// order on this job, never a cancelled one, and only the delivery is written.

const requireUser = vi.fn();
const adminConstructed = vi.fn();
const updates: Record<string, unknown>[] = [];
let order: Record<string, unknown> | null = null;

vi.mock("@/lib/api/guards", () => ({ requireUser: (...a: unknown[]) => requireUser(...a) }));
vi.mock("@/lib/monitoring", () => ({ reportError: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: vi.fn(() => {
    adminConstructed();
    const chain: Record<string, unknown> = {};
    chain.select = () => chain;
    chain.eq = () => chain;
    chain.maybeSingle = async () => ({ data: order, error: null });
    chain.update = (patch: Record<string, unknown>) => {
      updates.push(patch);
      return { eq: async () => ({ error: null }) };
    };
    return { from: () => chain };
  }),
}));

import { POST } from "@/app/api/jobs/[id]/supplier-orders/[orderId]/delivered/route";

const call = () =>
  POST(new NextRequest("http://localhost/x", { method: "POST" }), { params: Promise.resolve({ id: "job-1", orderId: "order-1" }) });

beforeEach(() => {
  vi.clearAllMocks();
  updates.length = 0;
  order = { id: "order-1", job_id: "job-1", status: "ordered", delivered_at: null };
});

describe("POST supplier order delivered", () => {
  it("refuses an unauthenticated caller before touching the database", async () => {
    requireUser.mockResolvedValue({ ok: false, response: new Response("{}", { status: 401 }) });
    expect((await call()).status).toBe(401);
    expect(adminConstructed).not.toHaveBeenCalled();
  });

  it("marks it received and delivered by the caller, nothing else", async () => {
    requireUser.mockResolvedValue({ ok: true, userId: "tech-1", role: null });
    const res = await call();
    expect(res.status).toBe(200);
    expect(updates).toHaveLength(1);
    expect(Object.keys(updates[0]).sort()).toEqual(["delivered_at", "delivered_by", "status"]);
    expect(updates[0]).toMatchObject({ status: "received", delivered_by: "tech-1" });
  });

  it("refuses an order from another job, and a cancelled one", async () => {
    requireUser.mockResolvedValue({ ok: true, userId: "tech-1", role: null });
    order = { id: "order-1", job_id: "job-2", status: "ordered", delivered_at: null };
    expect((await call()).status).toBe(404);
    order = { id: "order-1", job_id: "job-1", status: "cancelled", delivered_at: null };
    expect((await call()).status).toBe(400);
    expect(updates).toHaveLength(0);
  });

  it("keeps the first delivery when tapped twice", async () => {
    requireUser.mockResolvedValue({ ok: true, userId: "tech-1", role: null });
    order = { id: "order-1", job_id: "job-1", status: "received", delivered_at: "2026-10-31T01:00:00Z" };
    expect(await (await call()).json()).toEqual({ deliveredAt: "2026-10-31T01:00:00Z" });
    expect(updates).toHaveLength(0);
  });
});
