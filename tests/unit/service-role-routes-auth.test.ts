import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// The remaining routes that construct a service-role client — which bypasses RLS
// entirely — and therefore carry their whole authorization decision in code.
//
// All four are correctly guarded today (requireUser / requireCronSecret plus a
// per-record ownership check). None had a test, so nothing would notice if a
// guard were dropped: the route keeps working for the person who edits it, and
// the hole opens only for everyone else.
//
// The assertion that matters is not the status code — a route could return 403
// having already performed the privileged work. Each test also asserts the
// service-role side effect never happens on a rejected request.

const requireUser = vi.fn();
const requireCronSecret = vi.fn();
const canManageJobBilling = vi.fn();
const canManageTimeEntryBilling = vi.fn();
const syncJobBilling = vi.fn();
const syncTimeEntryBilling = vi.fn();
const adminConstructed = vi.fn();

vi.mock("@/lib/api/guards", () => ({
  requireUser: (...a: unknown[]) => requireUser(...a),
  requireCronSecret: (...a: unknown[]) => requireCronSecret(...a),
  requireAdmin: vi.fn(),
  requireOfficeOrAdmin: vi.fn(),
}));

vi.mock("@/lib/api/job-authz", () => ({
  canManageJobBilling: (...a: unknown[]) => canManageJobBilling(...a),
  canManageTimeEntryBilling: (...a: unknown[]) => canManageTimeEntryBilling(...a),
  canViewJob: vi.fn(async () => false),
  canViewBackflowTest: vi.fn(async () => false),
}));

vi.mock("@/lib/labour-billing-sync", () => ({
  syncJobBilling: (...a: unknown[]) => syncJobBilling(...a),
  syncTimeEntryBilling: (...a: unknown[]) => syncTimeEntryBilling(...a),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: vi.fn(() => {
    adminConstructed();
    const chain: Record<string, unknown> = {};
    for (const m of ["select", "eq", "update", "insert", "delete", "is", "order", "limit"]) {
      chain[m] = vi.fn(() => chain);
    }
    chain.single = vi.fn(async () => ({ data: null, error: null }));
    chain.maybeSingle = vi.fn(async () => ({ data: null, error: null }));
    chain.then = (r: (v: { data: never[]; error: null }) => unknown) => r({ data: [], error: null });
    return { from: vi.fn(() => chain), storage: { from: vi.fn(() => ({ download: vi.fn() })) } };
  }),
}));

import { POST as jobSyncBilling } from "@/app/api/jobs/[id]/sync-billing/route";
import { POST as entrySyncBilling } from "@/app/api/time-entries/[id]/sync-billing/route";
import { GET as pollInvoices } from "@/app/api/xero/poll-invoices/route";

const req = (url = "http://localhost/api/x") => new NextRequest(url, { method: "POST" });
const getReq = (url = "http://localhost/api/x") => new NextRequest(url, { method: "GET" });
const params = (id: string) => ({ params: Promise.resolve({ id }) });

const DENIED = {
  ok: false as const,
  response: new Response(JSON.stringify({ error: "Not authenticated" }), { status: 401 }),
};
const allowed = (userId = "user-1") => ({ ok: true as const, userId });

beforeEach(() => {
  vi.clearAllMocks();
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://unit-test.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "svc";
});

describe("POST /api/jobs/[id]/sync-billing", () => {
  it("returns 401 for an unauthenticated caller and never touches billing", async () => {
    requireUser.mockResolvedValue(DENIED);
    const res = await jobSyncBilling(req(), params("job-1"));
    expect(res.status).toBe(401);
    expect(syncJobBilling).not.toHaveBeenCalled();
  });

  it("returns 403 for a technician not assigned to the job", async () => {
    // A tech may reconcile billing on their OWN job (the mobile self-heal after
    // logging time) but not on someone else's.
    requireUser.mockResolvedValue(allowed("other-tech"));
    canManageJobBilling.mockResolvedValue(false);
    const res = await jobSyncBilling(req(), params("job-1"));
    expect(res.status).toBe(403);
    expect(syncJobBilling).not.toHaveBeenCalled();
  });

  it("proceeds when the caller is authorised for that job", async () => {
    requireUser.mockResolvedValue(allowed());
    canManageJobBilling.mockResolvedValue(true);
    syncJobBilling.mockResolvedValue({ created: 1 });
    const res = await jobSyncBilling(req(), params("job-1"));
    expect(res.status).toBe(200);
    expect(syncJobBilling).toHaveBeenCalled();
  });

  it("authorises against the job id from the URL, not one the caller supplies", async () => {
    requireUser.mockResolvedValue(allowed("user-9"));
    canManageJobBilling.mockResolvedValue(true);
    syncJobBilling.mockResolvedValue({});
    await jobSyncBilling(req("http://localhost/api/jobs/job-42/sync-billing"), params("job-42"));
    expect(canManageJobBilling).toHaveBeenCalledWith(expect.anything(), "user-9", "job-42");
  });
});

describe("POST /api/time-entries/[id]/sync-billing", () => {
  it("returns 401 for an unauthenticated caller and never touches billing", async () => {
    requireUser.mockResolvedValue(DENIED);
    const res = await entrySyncBilling(req(), params("entry-1"));
    expect(res.status).toBe(401);
    expect(syncTimeEntryBilling).not.toHaveBeenCalled();
  });

  // canManageTimeEntryBilling returns { allowed, jobId } rather than a boolean,
  // and the route distinguishes the two failures: a missing entry is 404, an
  // entry the caller may not touch is 403. Both must stop before the billing
  // write.
  it("returns 403 when the entry exists but the caller may not manage it", async () => {
    requireUser.mockResolvedValue(allowed("other-tech"));
    canManageTimeEntryBilling.mockResolvedValue({ allowed: false, jobId: "job-1" });
    const res = await entrySyncBilling(req(), params("entry-1"));
    expect(res.status).toBe(403);
    expect(syncJobBilling).not.toHaveBeenCalled();
  });

  it("returns 404 when the time entry does not exist", async () => {
    requireUser.mockResolvedValue(allowed());
    canManageTimeEntryBilling.mockResolvedValue({ allowed: false, jobId: null });
    const res = await entrySyncBilling(req(), params("missing"));
    expect(res.status).toBe(404);
    expect(syncJobBilling).not.toHaveBeenCalled();
  });

  it("reconciles the entry's OWN job when authorised, not a caller-supplied one", async () => {
    requireUser.mockResolvedValue(allowed("tech-1"));
    canManageTimeEntryBilling.mockResolvedValue({ allowed: true, jobId: "job-77" });
    syncJobBilling.mockResolvedValue({});
    const res = await entrySyncBilling(req(), params("entry-1"));
    expect(res.status).toBe(200);
    expect(syncJobBilling).toHaveBeenCalledWith(expect.anything(), "job-77");
  });
});

describe("GET /api/xero/poll-invoices (cron secret)", () => {
  it("rejects a caller without the cron secret", async () => {
    requireCronSecret.mockReturnValue({
      ok: false,
      response: new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 }),
    });
    const res = await pollInvoices(getReq());
    expect(res.status).toBe(401);
  });

  it("fails closed — a request is rejected when the guard denies, not allowed through", async () => {
    // requireCronSecret denies when CRON_SECRET is unset, so an unconfigured
    // deployment cannot leave the poller open to the internet.
    requireCronSecret.mockReturnValue({
      ok: false,
      response: new Response(null, { status: 401 }),
    });
    const res = await pollInvoices(getReq());
    expect(res.status).toBe(401);
    expect(adminConstructed).not.toHaveBeenCalled();
  });
});
