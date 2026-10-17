import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// /api/auth/login — the lockout funnel (0056).
//
// Two defects closed here. (1) The profile lookup was an exact `.eq` while
// Supabase Auth matches emails case-insensitively, so `Admin@x` signed in to
// `admin@x` WITHOUT ever being counted or checked — unlimited guesses by
// changing one letter. (2) A locked account answered 429 with its own message
// while a wrong password answered 401, so the response itself said which staff
// emails exist.

const ilike = vi.fn();
const rpc = vi.fn();
const signInWithPassword = vi.fn();

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: () => ({ select: () => ({ ilike: (...a: unknown[]) => ({ limit: async () => ilike(...a) }) }) }),
    rpc: (...a: unknown[]) => rpc(...a),
  }),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { signInWithPassword: (...a: unknown[]) => signInWithPassword(...a) } }),
}));

import { POST } from "@/app/api/auth/login/route";

const post = (email: string, password = "pw") =>
  new NextRequest("http://localhost/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });

const BAD_CREDS = { data: { session: null }, error: { status: 400, message: "Invalid login credentials" } };

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  ilike.mockResolvedValue({ data: [{ id: "u-admin", email: "admin@mellerick.test" }] });
  rpc.mockImplementation(async (fn: string) => (fn === "check_login_lockout" ? { data: { locked: false } } : { data: { locked: false } }));
  signInWithPassword.mockResolvedValue(BAD_CREDS);
});

describe("email normalisation", () => {
  it("finds the profile whatever the casing, and counts the failure against it", async () => {
    await POST(post("  ADMIN@Mellerick.Test "));
    expect(ilike).toHaveBeenCalledWith("email", "admin@mellerick.test");
    expect(rpc).toHaveBeenCalledWith("check_login_lockout", { p_user_id: "u-admin" });
    expect(rpc).toHaveBeenCalledWith("record_login_failure", { p_user_id: "u-admin" });
    expect(signInWithPassword).toHaveBeenCalledWith({ email: "admin@mellerick.test", password: "pw" });
  });

  it("escapes LIKE wildcards, and still requires an exact match", async () => {
    // `_` is legal in an email and a single-character wildcard in LIKE: a_b@x
    // must not match axb@x's profile and lock or count against it.
    ilike.mockResolvedValue({ data: [{ id: "u-other", email: "axb@mellerick.test" }] });
    await POST(post("a_b@mellerick.test"));
    expect(ilike).toHaveBeenCalledWith("email", "a\\_b@mellerick.test");
    expect(rpc).not.toHaveBeenCalled();
  });

  it("a locked account is refused BEFORE the password is checked, whatever the casing", async () => {
    rpc.mockResolvedValue({ data: { locked: true, message: "Too many failed attempts. Try again in 9 minute(s)" } });
    const res = await POST(post("Admin@Mellerick.test"));
    expect(res.status).toBe(401);
    expect(signInWithPassword).not.toHaveBeenCalled();
  });
});

describe("no account enumeration through the response", () => {
  async function answer(setup: () => void, email: string) {
    vi.clearAllMocks();
    signInWithPassword.mockResolvedValue(BAD_CREDS);
    setup();
    const res = await POST(post(email));
    return { status: res.status, body: await res.json() };
  }

  it("unknown email, wrong password, mid-lockout and the locking failure all answer the same", async () => {
    const unknown = await answer(() => ilike.mockResolvedValue({ data: [] }), "nobody@mellerick.test");
    const wrong = await answer(() => {
      ilike.mockResolvedValue({ data: [{ id: "u-admin", email: "admin@mellerick.test" }] });
      rpc.mockResolvedValue({ data: { locked: false } });
    }, "admin@mellerick.test");
    const locked = await answer(() => {
      ilike.mockResolvedValue({ data: [{ id: "u-admin", email: "admin@mellerick.test" }] });
      rpc.mockResolvedValue({ data: { locked: true, message: "Too many failed attempts…" } });
    }, "admin@mellerick.test");
    const tripping = await answer(() => {
      ilike.mockResolvedValue({ data: [{ id: "u-admin", email: "admin@mellerick.test" }] });
      rpc.mockImplementation(async (fn: string) =>
        fn === "record_login_failure" ? { data: { locked: true, message: "Too many failed attempts…" } } : { data: { locked: false } }
      );
    }, "admin@mellerick.test");

    expect(wrong).toEqual(unknown);
    expect(locked).toEqual(unknown);
    expect(tripping).toEqual(unknown);
    expect(unknown.status).toBe(401);
    // Still tells a genuinely locked-out person how to get back in.
    expect(unknown.body.error).toMatch(/Forgot password/);
  });

  it("does not pass GoTrue's own text through (e.g. 'Email not confirmed')", async () => {
    signInWithPassword.mockResolvedValue({ data: { session: null }, error: { status: 400, message: "Email not confirmed" } });
    const res = await POST(post("admin@mellerick.test"));
    expect((await res.json()).error).not.toMatch(/confirm/i);
  });

  it("an auth outage is reported as an outage, not a wrong password", async () => {
    signInWithPassword.mockResolvedValue({ data: { session: null }, error: { status: 502, message: "upstream" } });
    const res = await POST(post("admin@mellerick.test"));
    expect(res.status).toBe(503);
  });
});

describe("success", () => {
  it("clears the lockout and returns the session", async () => {
    signInWithPassword.mockResolvedValue({ data: { session: { access_token: "a", refresh_token: "r" } }, error: null });
    const res = await POST(post("Admin@Mellerick.test"));
    expect(res.status).toBe(200);
    expect(rpc).toHaveBeenCalledWith("clear_login_lockout", { p_user_id: "u-admin" });
  });
});

describe("the lockout says what it is", () => {
  it("documents that the anon key bypasses it", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("app/api/auth/login/route.ts", "utf8");
    expect(src).toMatch(/SPEED BUMP/);
    expect(src).toMatch(/anon key/);
  });
});
