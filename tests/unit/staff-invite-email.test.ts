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
    from: () => ({ upsert: (...a: unknown[]) => insert(...a) }),
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
    // Upsert: handle_new_user() (0044) has usually made the row already.
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({ email: "jake.henderson@mellerick.com" }), { onConflict: "id" });
  });

  it("links the invite to the app's own origin, never the request Host (the phone calls this too)", async () => {
    invite.mockClear();
    await POST(
      new NextRequest("http://evil.example/api/staff/invite", {
        method: "POST",
        body: JSON.stringify({ full_name: "Jake", email: "jake@mellerick.com", role: "technician" }),
      })
    );
    const opts = invite.mock.calls[0][1] as { redirectTo: string };
    expect(opts.redirectTo).not.toContain("evil.example");
    expect(opts.redirectTo).toMatch(/\/update-password$/);
  });

  it("refuses a malformed email or an unknown role without inviting", async () => {
    invite.mockClear();
    for (const body of [
      { full_name: "Jake", email: "not-an-email", role: "technician" },
      { full_name: "Jake", email: "jake@mellerick.com", role: "superuser" },
    ]) {
      const res = await POST(new NextRequest("http://localhost/api/staff/invite", { method: "POST", body: JSON.stringify(body) }));
      expect(res.status).toBe(400);
    }
    expect(invite).not.toHaveBeenCalled();
  });

  it("answers an existing account with a fixed sentence, not GoTrue's text", async () => {
    invite.mockImplementationOnce(async () => ({ data: { user: null }, error: { message: "A user with this email address has already been registered" } }) as never);
    const res = await POST(
      new NextRequest("http://localhost/api/staff/invite", {
        method: "POST",
        body: JSON.stringify({ full_name: "Jake", email: "jake@mellerick.com", role: "technician" }),
      })
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Someone with this email already has a login.");
  });
});
