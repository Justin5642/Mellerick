import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// The last two service-role routes. Both reach Storage under a key that bypasses
// RLS, so their in-code checks are the whole authorization decision.
//
// transcribe-voice-report carries the more interesting one: the caller supplies
// `storagePath` in the request body, and the route must prove that path belongs
// to the job in the URL. Without that check a technician could name any other
// job's audio and have the route download it for them under the service-role
// key — a classic IDOR, plus `..` traversal out of the bucket prefix. It is
// implemented correctly and had no test.
//
// The certificate route is deliberately readable by ANY authenticated staff
// member — its own comment says so, because office needs to see tests they did
// not perform. Testing the documented contract, not an invented stricter one.

const requireUser = vi.fn();
const anonGetUser = vi.fn();
const download = vi.fn();
const createSignedUrl = vi.fn();
const single = vi.fn();

vi.mock("@/lib/api/guards", () => ({
  requireUser: (...a: unknown[]) => requireUser(...a),
  // transcribe-voice-report now uses the SHARED getCallerId rather than a local
  // Bearer-only copy. Delegating to the same anonGetUser these tests already
  // drive keeps the two 401 cases below meaning exactly what they meant before.
  getCallerId: async (req: NextRequest) => {
    const h = req.headers.get("authorization") ?? "";
    if (!h.startsWith("Bearer ")) return null;
    const { data, error } = await anonGetUser();
    return error || !data?.user ? null : data.user.id;
  },
  requireAdmin: vi.fn(),
  requireOfficeOrAdmin: vi.fn(),
  requireCronSecret: vi.fn(),
}));

// Membership is asserted in tests/unit/transcribe-voice-report-auth.test.ts.
// Here it must PASS, so the path-ownership assertions below are reached — the
// point of these tests is the IDOR guard, not the membership one.
vi.mock("@/lib/api/job-authz", () => ({
  canManageJobBilling: vi.fn(async () => true),
  canManageTimeEntryBilling: vi.fn(async () => true),
  isOfficeOrAdmin: vi.fn(async () => true),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: vi.fn(() => ({
    from: vi.fn(() => {
      const chain: Record<string, unknown> = {};
      chain.select = vi.fn(() => chain);
      chain.eq = vi.fn(() => chain);
      chain.single = single;
      chain.update = vi.fn(() => chain);
      return chain;
    }),
    storage: { from: vi.fn(() => ({ createSignedUrl, download })) },
  })),
}));

vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => ({
    auth: { getUser: anonGetUser },
    from: vi.fn(() => {
      const chain: Record<string, unknown> = {};
      for (const m of ["select", "eq", "update", "insert"]) chain[m] = vi.fn(() => chain);
      chain.single = single;
      return chain;
    }),
    storage: { from: vi.fn(() => ({ download, createSignedUrl })) },
  })),
}));

import { GET as certificateGET } from "@/app/api/backflow/tests/[id]/certificate/route";
import { POST as transcribePOST } from "@/app/api/jobs/[id]/transcribe-voice-report/route";

const params = (id: string) => ({ params: Promise.resolve({ id }) });
const DENIED = {
  ok: false as const,
  response: new Response(JSON.stringify({ error: "Not authenticated" }), { status: 401 }),
};

function bearerPost(body: unknown, token = "good-token") {
  return new NextRequest("http://localhost/api/jobs/job-1/transcribe-voice-report", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://unit-test.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "svc";
  // transcribe-voice-report short-circuits with 500 when this is unset, before
  // it reaches the path-ownership check. That ordering is deliberate — it sits
  // AFTER the 401, so an anonymous caller learns nothing about server config —
  // but it means these tests must set it to exercise the checks beyond it.
  process.env.OPENAI_API_KEY = "test-key";
  single.mockResolvedValue({ data: null, error: null });
});

describe("GET /api/backflow/tests/[id]/certificate", () => {
  it("returns 401 for an unauthenticated caller and issues no signed URL", async () => {
    requireUser.mockResolvedValue(DENIED);
    const res = await certificateGET(new NextRequest("http://localhost/x"), params("test-1"));
    expect(res.status).toBe(401);
    expect(createSignedUrl).not.toHaveBeenCalled();
  });

  it("returns 404 when the test has no certificate on file", async () => {
    requireUser.mockResolvedValue({ ok: true, userId: "u1" });
    single.mockResolvedValue({ data: { certificate_storage_path: null }, error: null });
    const res = await certificateGET(new NextRequest("http://localhost/x"), params("test-1"));
    expect(res.status).toBe(404);
    expect(createSignedUrl).not.toHaveBeenCalled();
  });

  it("issues a SHORT-LIVED signed URL — the link is the access control", async () => {
    requireUser.mockResolvedValue({ ok: true, userId: "u1" });
    single.mockResolvedValue({ data: { certificate_storage_path: "cert/abc.pdf" }, error: null });
    createSignedUrl.mockResolvedValue({ data: { signedUrl: "https://signed" }, error: null });

    await certificateGET(new NextRequest("http://localhost/x?json=1"), params("test-1"));

    const [, expiresIn] = createSignedUrl.mock.calls[0];
    expect(expiresIn).toBeLessThanOrEqual(3600); // minutes, not a durable link
    expect(expiresIn).toBeGreaterThan(0);
  });
});

describe("POST /api/jobs/[id]/transcribe-voice-report — path ownership", () => {
  const validUser = () => anonGetUser.mockResolvedValue({ data: { user: { id: "tech-1" } }, error: null });

  it("returns 401 without a Bearer token", async () => {
    const res = await transcribePOST(
      new NextRequest("http://localhost/x", { method: "POST", body: "{}" }),
      params("job-1")
    );
    expect(res.status).toBe(401);
    expect(download).not.toHaveBeenCalled();
  });

  it("returns 401 when the token does not resolve to a user", async () => {
    anonGetUser.mockResolvedValue({ data: { user: null }, error: { message: "bad token" } });
    const res = await transcribePOST(bearerPost({ storagePath: "job-1/a.m4a" }), params("job-1"));
    expect(res.status).toBe(401);
    expect(download).not.toHaveBeenCalled();
  });

  // THE IDOR. The caller supplies storagePath; without this check a technician
  // could name another job's audio and have the service-role key fetch it.
  it("refuses a storagePath belonging to a DIFFERENT job", async () => {
    validUser();
    const res = await transcribePOST(bearerPost({ storagePath: "job-999/secret.m4a" }), params("job-1"));
    expect(res.status).toBe(403);
    expect(download).not.toHaveBeenCalled();
  });

  it("refuses directory traversal out of the job prefix", async () => {
    validUser();
    const res = await transcribePOST(
      bearerPost({ storagePath: "job-1/../job-999/secret.m4a" }),
      params("job-1")
    );
    expect(res.status).toBe(403);
    expect(download).not.toHaveBeenCalled();
  });

  it("refuses a path that merely starts with the job id as a prefix string", async () => {
    // "job-11/..." starts with "job-1" as raw text; the check requires the
    // separator, so a neighbouring job cannot be reached by prefix collision.
    validUser();
    const res = await transcribePOST(bearerPost({ storagePath: "job-11/other.m4a" }), params("job-1"));
    expect(res.status).toBe(403);
    expect(download).not.toHaveBeenCalled();
  });

  it("returns 400 when storagePath is missing entirely", async () => {
    validUser();
    const res = await transcribePOST(bearerPost({}), params("job-1"));
    expect(res.status).toBe(400);
    expect(download).not.toHaveBeenCalled();
  });
});
