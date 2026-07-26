import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";

// Q1 regression. The route authenticated a mobile Bearer caller but then built a
// COOKIE-scoped Supabase client, so those queries ran as `anon`: google_tokens is
// office/admin-only (migration 0027), the token read came back empty, and the
// route answered 200 {skipped:true}. The mobile outbox treats a 200 as success,
// so the op was marked done and the calendar NEVER synced — silently, forever.
// The fix uses the service-role client (so the token is readable regardless of
// the caller's transport) plus an explicit per-record authz check.

const requireUser = vi.fn((..._a: unknown[]) => undefined as unknown);
const canManageJobBilling = vi.fn(async (..._a: unknown[]) => true as boolean);
const getGoogleCalendarClient = vi.fn(async (..._a: unknown[]) => null as unknown);
const createAdminClient = vi.fn(() => ({ __kind: "service-role" }));

vi.mock("@/lib/api/guards", () => ({ requireUser: (...a: unknown[]) => requireUser(...a) }));
vi.mock("@/lib/api/job-authz", () => ({ canManageJobBilling: (...a: unknown[]) => canManageJobBilling(...a) }));
vi.mock("@/lib/google", () => ({ getGoogleCalendarClient: (...a: unknown[]) => getGoogleCalendarClient(...a) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => createAdminClient() }));

// If the route ever reaches for the cookie client again, this mock makes it obvious.
const cookieClient = vi.fn();
vi.mock("@/lib/supabase/server", () => ({ createClient: () => cookieClient() }));

import { POST } from "@/app/api/jobs/[id]/sync-calendar/route";

const req = () => new NextRequest("https://app.test/api/jobs/j1/sync-calendar", { method: "POST" });
const params = { params: Promise.resolve({ id: "j1" }) };

beforeEach(() => {
  vi.clearAllMocks();
  requireUser.mockResolvedValue({ ok: true, userId: "u1", role: null });
  canManageJobBilling.mockResolvedValue(true);
  getGoogleCalendarClient.mockResolvedValue(null);
});

describe("sync-calendar — Bearer-capable auth (Q1)", () => {
  it("reads Google tokens with the SERVICE-ROLE client, never the cookie client", async () => {
    await POST(req(), params);
    expect(createAdminClient).toHaveBeenCalledTimes(1);
    expect(cookieClient).not.toHaveBeenCalled(); // the bug: cookie client made a Bearer caller `anon`
    // The token lookup must be handed that client, or a Bearer caller reads nothing.
    expect(getGoogleCalendarClient).toHaveBeenCalledWith({ __kind: "service-role" });
  });

  it("rejects an unauthenticated caller before touching Google or the DB", async () => {
    requireUser.mockResolvedValue({ ok: false, response: NextResponse.json({ error: "x" }, { status: 401 }) });
    const res = await POST(req(), params);
    expect(res.status).toBe(401);
    expect(createAdminClient).not.toHaveBeenCalled();
    expect(getGoogleCalendarClient).not.toHaveBeenCalled();
  });

  it("403s a caller who may not manage this job (service-role bypasses RLS, so authz is explicit)", async () => {
    canManageJobBilling.mockResolvedValue(false);
    const res = await POST(req(), params);
    expect(res.status).toBe(403);
    expect(getGoogleCalendarClient).not.toHaveBeenCalled();
  });

  it("still reports skipped (not an error) when Google genuinely isn't connected", async () => {
    getGoogleCalendarClient.mockResolvedValue(null);
    const res = await POST(req(), params);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ skipped: true });
  });
});
