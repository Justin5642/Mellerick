import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// London-school tests for the auth/authz guards. We mock the three Supabase
// seams and assert the *contract*: which status comes back for each caller,
// and that the admin (service-role) client is only ever consulted for role
// reads — never as a way to skip authorization.

const serverGetUser = vi.fn();
const anonGetUser = vi.fn();
const adminFrom = vi.fn();

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({ auth: { getUser: serverGetUser } })),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: vi.fn(() => ({ from: adminFrom })),
}));

vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => ({ auth: { getUser: anonGetUser } })),
}));

import { requireUser, requireAdmin, requireOfficeOrAdmin, requireCronSecret, getCallerId } from "@/lib/api/guards";

function req(headers: Record<string, string> = {}) {
  return new NextRequest("http://test.local/api/x", { method: "POST", headers });
}

function roleRow(role: string | null) {
  const chain = {
    select: vi.fn(() => chain),
    eq: vi.fn(() => chain),
    single: vi.fn(async () => ({ data: role ? { role } : null, error: null })),
  };
  return chain;
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://unit-test.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon";
  delete process.env.CRON_SECRET;
});

describe("getCallerId", () => {
  it("resolves the user id from a valid Bearer token", async () => {
    anonGetUser.mockResolvedValue({ data: { user: { id: "u-mobile" } }, error: null });
    expect(await getCallerId(req({ authorization: "Bearer good-token" }))).toBe("u-mobile");
  });

  it("returns null for an invalid Bearer token", async () => {
    anonGetUser.mockResolvedValue({ data: { user: null }, error: { message: "bad" } });
    expect(await getCallerId(req({ authorization: "Bearer bad" }))).toBeNull();
  });

  it("falls back to the session cookie when no Bearer token is present", async () => {
    serverGetUser.mockResolvedValue({ data: { user: { id: "u-web" } } });
    expect(await getCallerId(req())).toBe("u-web");
  });
});

describe("requireUser", () => {
  it("401s an unauthenticated caller", async () => {
    serverGetUser.mockResolvedValue({ data: { user: null } });
    const r = await requireUser(req());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.response.status).toBe(401);
  });

  it("passes an authenticated caller and never consults the service-role client", async () => {
    serverGetUser.mockResolvedValue({ data: { user: { id: "u-web" } } });
    const r = await requireUser(req());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.userId).toBe("u-web");
    expect(adminFrom).not.toHaveBeenCalled();
  });
});

describe("requireAdmin / requireOfficeOrAdmin", () => {
  it("403s a technician trying an admin route", async () => {
    serverGetUser.mockResolvedValue({ data: { user: { id: "u1" } } });
    adminFrom.mockReturnValue(roleRow("technician"));
    const r = await requireAdmin(req());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.response.status).toBe(403);
  });

  it("allows an admin through requireAdmin", async () => {
    serverGetUser.mockResolvedValue({ data: { user: { id: "u1" } } });
    adminFrom.mockReturnValue(roleRow("admin"));
    const r = await requireAdmin(req());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.role).toBe("admin");
  });

  it("403s a technician but allows office+admin through requireOfficeOrAdmin", async () => {
    serverGetUser.mockResolvedValue({ data: { user: { id: "u1" } } });

    adminFrom.mockReturnValue(roleRow("technician"));
    const tech = await requireOfficeOrAdmin(req());
    expect(tech.ok).toBe(false);
    if (!tech.ok) expect(tech.response.status).toBe(403);

    adminFrom.mockReturnValue(roleRow("office"));
    expect((await requireOfficeOrAdmin(req())).ok).toBe(true);

    adminFrom.mockReturnValue(roleRow("admin"));
    expect((await requireOfficeOrAdmin(req())).ok).toBe(true);
  });

  it("401s (not 403) before any role lookup when unauthenticated", async () => {
    serverGetUser.mockResolvedValue({ data: { user: null } });
    const r = await requireAdmin(req());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.response.status).toBe(401);
    expect(adminFrom).not.toHaveBeenCalled();
  });
});

describe("requireCronSecret", () => {
  it("fails closed with 500 when CRON_SECRET is not configured", () => {
    const r = requireCronSecret(req({ authorization: "Bearer anything" }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.response.status).toBe(500);
  });

  it("401s a wrong/absent secret", () => {
    process.env.CRON_SECRET = "s3cret";
    const r = requireCronSecret(req({ authorization: "Bearer wrong" }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.response.status).toBe(401);
  });

  it("passes the correct secret", () => {
    process.env.CRON_SECRET = "s3cret";
    expect(requireCronSecret(req({ authorization: "Bearer s3cret" })).ok).toBe(true);
  });
});
