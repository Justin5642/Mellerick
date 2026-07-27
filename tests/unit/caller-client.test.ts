import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// Contract test for the caller-scoped Supabase client that lets the invoice/
// quote send+pdf routes serve BOTH a mobile Bearer token and a web cookie
// session. The critical guarantees: a Bearer token yields a client whose
// Authorization header is the caller's JWT (so RLS runs as that user), and the
// ABSENCE of a token falls back to the unchanged cookie client (so web behaviour
// can't regress).

const tokenClientMarker = { __kind: "token-client" };
const cookieClientMarker = { __kind: "cookie-client" };
const supabaseCreate = vi.fn((..._args: unknown[]) => tokenClientMarker);

vi.mock("@supabase/supabase-js", () => ({
  createClient: (...args: unknown[]) => supabaseCreate(...args),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => cookieClientMarker),
}));

import { callerClient } from "@/lib/api/caller-client";

function req(headers: Record<string, string> = {}) {
  return new NextRequest("https://app.test/api/invoices/x/send", { method: "POST", headers });
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://unit-test.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-key";
});

describe("callerClient", () => {
  it("builds a token-scoped client whose Authorization header is the caller's JWT (mobile Bearer path)", async () => {
    const client = await callerClient(req({ authorization: "Bearer user-jwt-123" }));
    expect(client).toBe(tokenClientMarker);
    expect(supabaseCreate).toHaveBeenCalledTimes(1);
    const [url, key, opts] = supabaseCreate.mock.calls[0] as unknown as [string, string, Record<string, unknown>];
    expect(url).toBe("https://unit-test.supabase.co");
    expect(key).toBe("anon-key"); // apikey stays anon; RLS comes from the header
    const headers = (opts.global as { headers: Record<string, string> }).headers;
    expect(headers.Authorization).toBe("Bearer user-jwt-123");
    expect((opts.auth as { persistSession: boolean }).persistSession).toBe(false);
  });

  it("falls back to the cookie-session client when there is no Bearer token (web path unchanged)", async () => {
    const client = await callerClient(req());
    expect(client).toBe(cookieClientMarker);
    expect(supabaseCreate).not.toHaveBeenCalled();
  });

  it("ignores a non-Bearer Authorization header (no token → cookie client)", async () => {
    const client = await callerClient(req({ authorization: "Basic abc" }));
    expect(client).toBe(cookieClientMarker);
    expect(supabaseCreate).not.toHaveBeenCalled();
  });
});
