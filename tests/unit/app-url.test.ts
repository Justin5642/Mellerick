import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

// Emailed password-reset links used to be built from the request's own origin,
// i.e. the Host header — which the requester controls. A reset requested for a
// staff email with a forged Host would mail that person a link to someone
// else's server, tokens in the fragment. The origin now comes from config.

const resetPasswordForEmail = vi.fn(async (..._a: unknown[]) => ({ error: null as null | { status: number; message: string } }));
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({ auth: { resetPasswordForEmail: (...a: unknown[]) => resetPasswordForEmail(...a) } }),
}));

import { appUrl, PRODUCTION_APP_URL } from "@/lib/env";
import { POST } from "@/app/api/auth/forgot-password/route";

const saved = { ...process.env };
beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.APP_URL;
  delete process.env.NEXT_PUBLIC_APP_URL;
});
afterEach(() => {
  process.env = { ...saved };
});

describe("appUrl", () => {
  it("falls back to production when nothing is configured", () => {
    expect(appUrl()).toBe(PRODUCTION_APP_URL);
    expect(PRODUCTION_APP_URL).toBe("https://mellerick-app.vercel.app");
  });

  it("prefers APP_URL, then NEXT_PUBLIC_APP_URL, and drops a trailing slash", () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://public.example/";
    expect(appUrl()).toBe("https://public.example");
    process.env.APP_URL = "http://localhost:3000/";
    expect(appUrl()).toBe("http://localhost:3000");
  });
});

describe("POST /api/auth/forgot-password", () => {
  const req = (host: string) =>
    new NextRequest(`https://${host}/api/auth/forgot-password`, {
      method: "POST",
      headers: { host },
      body: JSON.stringify({ email: "jake@mellerick.test" }),
    });

  it("ignores the request host when building the reset link", async () => {
    await POST(req("evil.example"));
    const opts = resetPasswordForEmail.mock.calls[0][1] as { redirectTo: string };
    expect(opts.redirectTo).toBe("https://mellerick-app.vercel.app/update-password");
  });

  it("does not echo Supabase's error text", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    resetPasswordForEmail.mockResolvedValueOnce({ error: { status: 400, message: "Unable to validate email address: invalid format" } });
    const res = await POST(req("mellerick-app.vercel.app"));
    expect(res.status).toBe(400);
    expect((await res.json()).error).not.toMatch(/validate/);
  });

  it("keeps the rate-limit status so the page can say 'wait'", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    resetPasswordForEmail.mockResolvedValueOnce({ error: { status: 429, message: "email rate limit exceeded" } });
    const res = await POST(req("mellerick-app.vercel.app"));
    expect(res.status).toBe(429);
  });
});

describe(".env.example documents it", () => {
  it("lists APP_URL", async () => {
    const { readFileSync } = await import("node:fs");
    expect(readFileSync(".env.example", "utf8")).toMatch(/^APP_URL=$/m);
  });
});
