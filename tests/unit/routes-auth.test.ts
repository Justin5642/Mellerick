import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// Route-level authorization contract tests (London school). We drive each
// hardened handler through the guard seams and assert the status matrix:
// unauthenticated -> 401, wrong role -> 403, and that the service-role client
// is NOT used to perform the action when authorization fails.

const serverGetUser = vi.fn();
const anonGetUser = vi.fn();
const adminFrom = vi.fn();
const adminConstructed = vi.fn();

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser: serverGetUser },
    from: vi.fn(() => {
      const chain: Record<string, unknown> = {};
      for (const m of ["select", "update", "eq", "delete", "neq"]) chain[m] = vi.fn(() => chain);
      chain.single = vi.fn(async () => ({ data: { id: "row-1" }, error: null }));
      chain.then = (r: (v: { error: null }) => unknown) => r({ error: null });
      return chain;
    }),
  })),
}));

vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => ({ auth: { getUser: anonGetUser } })),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: vi.fn(() => {
    adminConstructed();
    return { from: adminFrom };
  }),
}));

import { POST as expenseCodePOST } from "@/app/api/xero/expense-account-code/route";
import { POST as disconnectPOST } from "@/app/api/google/disconnect/route";
import { GET as geocodeGET } from "@/app/api/geocode/route";
import { GET as xeroAuthGET } from "@/app/api/xero/auth/route";
import { GET as xeroCallbackGET } from "@/app/api/xero/callback/route";
import { GET as pollCalendarGET } from "@/app/api/google/poll-calendar/route";

function roleChain(role: string | null) {
  const chain: Record<string, unknown> = {};
  chain.select = vi.fn(() => chain);
  chain.eq = vi.fn(() => chain);
  chain.single = vi.fn(async () => ({ data: role ? { role } : null, error: null }));
  return chain;
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://unit-test.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "svc";
});

describe("POST /api/xero/expense-account-code (office/admin only)", () => {
  function post(body: unknown) {
    return new NextRequest("http://test.local/api/xero/expense-account-code", {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  it("401s an unauthenticated caller", async () => {
    serverGetUser.mockResolvedValue({ data: { user: null } });
    const res = await expenseCodePOST(post({ accountCode: "429" }));
    expect(res.status).toBe(401);
  });

  it("403s a technician", async () => {
    serverGetUser.mockResolvedValue({ data: { user: { id: "u1" } } });
    adminFrom.mockReturnValue(roleChain("technician"));
    const res = await expenseCodePOST(post({ accountCode: "429" }));
    expect(res.status).toBe(403);
  });

  it("allows an office user through", async () => {
    serverGetUser.mockResolvedValue({ data: { user: { id: "u1" } } });
    adminFrom.mockReturnValue(roleChain("office"));
    const res = await expenseCodePOST(post({ accountCode: "429" }));
    expect(res.status).toBe(200);
  });
});

describe("POST /api/google/disconnect (admin only)", () => {
  function post() {
    return new NextRequest("http://test.local/api/google/disconnect", { method: "POST" });
  }

  it("401s an unauthenticated caller and never builds the service-role client", async () => {
    serverGetUser.mockResolvedValue({ data: { user: null } });
    const res = await disconnectPOST(post());
    expect(res.status).toBe(401);
    expect(adminConstructed).not.toHaveBeenCalled();
  });

  it("403s an office user (admin required)", async () => {
    serverGetUser.mockResolvedValue({ data: { user: { id: "u1" } } });
    adminFrom.mockReturnValue(roleChain("office"));
    const res = await disconnectPOST(post());
    expect(res.status).toBe(403);
  });

  it("redirects an admin (302/307) after disconnecting", async () => {
    serverGetUser.mockResolvedValue({ data: { user: { id: "u1" } } });
    adminFrom.mockReturnValue(roleChain("admin"));
    const res = await disconnectPOST(post());
    expect([302, 307]).toContain(res.status);
  });
});

describe("GET /api/geocode (authenticated only)", () => {
  function get() {
    return new NextRequest("http://test.local/api/geocode?address=1%20Test%20St", { method: "GET" });
  }

  it("401s an unauthenticated caller before making any outbound fetch", async () => {
    serverGetUser.mockResolvedValue({ data: { user: null } });
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const res = await geocodeGET(get());
    expect(res.status).toBe(401);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});

describe("OAuth connect routes (admin only, both initiation and callback)", () => {
  it("xero/auth 403s a non-admin before building the consent URL", async () => {
    serverGetUser.mockResolvedValue({ data: { user: { id: "u1" } } });
    adminFrom.mockReturnValue(roleChain("office"));
    const res = await xeroAuthGET(new NextRequest("http://test.local/api/xero/auth"));
    expect(res.status).toBe(403);
  });

  it("xero/callback 403s a non-admin before writing tokens", async () => {
    serverGetUser.mockResolvedValue({ data: { user: { id: "u1" } } });
    adminFrom.mockReturnValue(roleChain("technician"));
    const res = await xeroCallbackGET(new NextRequest("http://test.local/api/xero/callback?code=x"));
    expect(res.status).toBe(403);
  });

  it("xero/callback 401s an unauthenticated caller", async () => {
    serverGetUser.mockResolvedValue({ data: { user: null } });
    const res = await xeroCallbackGET(new NextRequest("http://test.local/api/xero/callback?code=x"));
    expect(res.status).toBe(401);
  });
});

describe("GET /api/google/poll-calendar (cron secret)", () => {
  it("500s when CRON_SECRET is unset (fails closed)", async () => {
    delete process.env.CRON_SECRET;
    const res = await pollCalendarGET(new NextRequest("http://test.local/api/google/poll-calendar"));
    expect(res.status).toBe(500);
  });

  it("401s a wrong secret", async () => {
    process.env.CRON_SECRET = "s3cret";
    const res = await pollCalendarGET(
      new NextRequest("http://test.local/api/google/poll-calendar", { headers: { authorization: "Bearer wrong" } })
    );
    expect(res.status).toBe(401);
    delete process.env.CRON_SECRET;
  });
});
