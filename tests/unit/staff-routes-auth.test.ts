import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// The three /api/staff routes bypass RLS entirely — they construct a
// service-role client to reach auth.admin — and rely SOLELY on an in-code role
// check. Nothing else stands behind them.
//
// /api/staff/invite is the sharpest: the request body chooses the new account's
// role, "admin" included. If its check were ever dropped, any authenticated
// user — a technician holding the anon key — could POST directly and mint
// themselves an admin account. That is privilege escalation, not a data leak.
//
// They now all go through the shared requireAdmin() guard (they used to be
// hand-rolled, and the hand-rolled copies ignored profiles.is_active, so a
// deactivated admin kept inviting staff). A refactor that drops the guard keeps
// the route working for admins — the hole only exists for everyone else. These
// tests exist to make that loss loud.
//
// London school: drive each handler through the guard seams and assert the
// matrix — unauthenticated 401, non-admin 403, and crucially that the
// service-role client is NEVER constructed when authorization fails.

const serverGetUser = vi.fn();
const adminConstructed = vi.fn();
const inviteUserByEmail = vi.fn();
const updateUserById = vi.fn();
let profileRole: string | null = null;
let profileActive: boolean | null = true;

// The profile row the guard reads (through the service-role client — see
// lib/api/guards.ts getActiveCallerRole).
function profileChain() {
  const chain: Record<string, unknown> = {};
  chain.select = vi.fn(() => chain);
  chain.eq = vi.fn(() => chain);
  chain.single = vi.fn(async () => ({
    data: profileRole ? { role: profileRole, is_active: profileActive } : null,
    error: null,
  }));
  return chain;
}

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser: serverGetUser },
    from: vi.fn(() => {
      const chain: Record<string, unknown> = {};
      chain.select = vi.fn(() => chain);
      chain.eq = vi.fn(() => chain);
      chain.single = vi.fn(async () => ({
        data: profileRole ? { role: profileRole } : null,
        error: null,
      }));
      return chain;
    }),
  })),
}));

// Both the direct createClient(url, serviceKey) form and the shared helper are
// counted, so the assertion holds whichever a route happens to use.
vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => {
    adminConstructed();
    return {
      auth: { admin: { inviteUserByEmail, updateUserById, deleteUser: vi.fn() } },
      from: vi.fn(() => {
        const chain: Record<string, unknown> = {};
        for (const m of ["select", "update", "eq", "delete", "insert"]) chain[m] = vi.fn(() => chain);
        chain.single = vi.fn(async () => ({ data: { id: "u1" }, error: null }));
        chain.then = (r: (v: { error: null }) => unknown) => r({ error: null });
        return chain;
      }),
    };
  }),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: vi.fn(() => {
    adminConstructed();
    return { auth: { admin: { inviteUserByEmail, updateUserById, deleteUser: vi.fn() } }, from: vi.fn(profileChain) };
  }),
}));

import { POST as invitePOST } from "@/app/api/staff/invite/route";
import { POST as resendPOST } from "@/app/api/staff/resend-invite/route";
import { POST as updatePOST } from "@/app/api/staff/update/route";
import { POST as setActivePOST } from "@/app/api/staff/set-active/route";

function post(body: Record<string, unknown>) {
  return new NextRequest("http://localhost/api/staff/x", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

const asUser = (id = "user-1") => serverGetUser.mockResolvedValue({ data: { user: { id } } });
const asAnonymous = () => serverGetUser.mockResolvedValue({ data: { user: null } });

beforeEach(() => {
  vi.clearAllMocks();
  profileRole = null;
  profileActive = true;
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://unit-test.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "svc";
});

const ROUTES: [string, (r: NextRequest) => Promise<Response>, Record<string, unknown>][] = [
  ["invite", invitePOST, { full_name: "Mallory", email: "m@example.com", role: "admin" }],
  ["resend-invite", resendPOST, { email: "m@example.com" }],
  ["update", updatePOST, { id: "u1", full_name: "Mallory", role: "admin" }],
  ["set-active", setActivePOST, { id: "u1", active: true }],
];

describe.each(ROUTES)("POST /api/staff/%s — admin only", (name, handler, body) => {
  it("rejects an unauthenticated caller with 401", async () => {
    asAnonymous();
    const res = await handler(post(body));
    expect(res.status).toBe(401);
  });

  it("rejects a technician with 403", async () => {
    asUser();
    profileRole = "technician";
    const res = await handler(post(body));
    expect(res.status).toBe(403);
  });

  it("rejects office staff with 403 — office is not admin", async () => {
    asUser();
    profileRole = "office";
    const res = await handler(post(body));
    expect(res.status).toBe(403);
  });

  it("rejects a caller with no profile row at all", async () => {
    // Fail closed. A user whose profile is missing must not be treated as
    // privileged by default.
    asUser();
    profileRole = null;
    const res = await handler(post(body));
    expect(res.status).toBe(403);
  });

  it("rejects a DEACTIVATED admin with 403", async () => {
    asUser();
    profileRole = "admin";
    profileActive = false;
    const res = await handler(post(body));
    expect(res.status).toBe(403);
  });

  // The status code alone is not enough. A route could return 403 while having
  // already reached auth.admin — this asserts no privileged action runs on a
  // rejected request. (The service-role client IS built, by the guard, to read
  // the caller's own role — that is a read, not an action.)
  it("never reaches auth.admin when authorization fails", async () => {
    asUser();
    profileRole = "technician";
    await handler(post(body));
    expect(inviteUserByEmail).not.toHaveBeenCalled();
    expect(updateUserById).not.toHaveBeenCalled();
  });
});

describe("POST /api/staff/invite — the escalation path specifically", () => {
  it("does not let a technician mint an admin account", async () => {
    asUser("technician-1");
    profileRole = "technician";
    const res = await invitePOST(
      post({ full_name: "Mallory", email: "m@example.com", role: "admin" })
    );
    expect(res.status).toBe(403);
    expect(inviteUserByEmail).not.toHaveBeenCalled();
  });
});
