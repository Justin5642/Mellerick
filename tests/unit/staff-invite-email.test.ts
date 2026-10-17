import { describe, it, expect, vi } from "vitest";
import { NextRequest } from "next/server";

// Invited emails are stored lowercase. Supabase Auth keeps them lowercase;
// profiles.email is what /api/auth/login looks the lockout up by, so a profile
// saved as "Jake@X" was a second spelling of the same account that the lookup
// had to work around (see tests/unit/login-route.test.ts).

const invite = vi.fn(async (..._a: unknown[]) => ({ data: { user: { id: "new-1" } }, error: null }));
const insert = vi.fn(async (..._a: unknown[]) => ({ error: null }));

// /api/staff/invite authorises through requireAdmin (tested in
// staff-routes-auth.test.ts); this file is only about email casing.
vi.mock("@/lib/api/guards", () => ({
  requireAdmin: async () => ({ ok: true, userId: "admin-1", role: "admin" }),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: "admin-1" } } }) },
    from: () => ({ select: () => ({ eq: () => ({ single: async () => ({ data: { role: "admin" } }) }) }) }),
  }),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    auth: { admin: { inviteUserByEmail: (...a: unknown[]) => invite(...a) } },
    from: () => ({ insert: (...a: unknown[]) => insert(...a) }),
  }),
}));

import { POST } from "@/app/api/staff/invite/route";

describe("staff invite email casing", () => {
  it("invites and stores the email trimmed and lowercased", async () => {
    const res = await POST(
      new NextRequest("http://localhost/api/staff/invite", {
        method: "POST",
        body: JSON.stringify({ full_name: "Jake", email: "  Jake.Henderson@Mellerick.COM ", role: "technician" }),
      })
    );
    expect(res.status).toBe(200);
    expect(invite.mock.calls[0][0]).toBe("jake.henderson@mellerick.com");
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({ email: "jake.henderson@mellerick.com" }));
  });
});
