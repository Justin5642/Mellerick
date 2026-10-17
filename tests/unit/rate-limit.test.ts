import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// The paid AI routes are rate limited per user in Postgres (migration 0076 —
// a DRAFT, NOT APPLIED to production yet), so the count is shared by every
// serverless instance rather than reset by each cold start like the geocode
// route's in-memory Map.
//
// The property that matters most before 0076 is applied: a missing RPC FAILS
// OPEN. Otherwise merging this would take AI polish and plate scanning down
// for everyone until the migration ran.

const rpc = vi.fn();
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ rpc: (...a: unknown[]) => rpc(...a) }) }));
const reportFailure = vi.fn();
vi.mock("@/lib/monitoring", () => ({ reportFailure: (...a: unknown[]) => reportFailure(...a), reportError: vi.fn() }));
// The route authenticates through the shared guard (which also refuses a
// deactivated profile); these tests are about what happens after that.
vi.mock("@/lib/api/guards", () => ({
  requireUser: async () => ({ ok: true, userId: "tech-1", role: null }),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: "tech-1" } } }) } }),
}));

import { consumeRateLimit, SCAN_DATA_PLATE_LIMIT } from "@/lib/api/rate-limit";
import { POST as scan } from "@/app/api/backflow/scan-data-plate/route";

const fetchMock = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockResolvedValue(
    new Response(JSON.stringify({ content: [{ type: "tool_use", input: { make: "Zurn" } }] }), { status: 200 })
  );
  process.env.ANTHROPIC_API_KEY = "test-key";
  rpc.mockResolvedValue({ data: true, error: null });
});

describe("consumeRateLimit", () => {
  it("passes the caller and bucket to the shared counter", async () => {
    await expect(consumeRateLimit("u1", SCAN_DATA_PLATE_LIMIT)).resolves.toBe(true);
    expect(rpc).toHaveBeenCalledWith("consume_rate_limit", {
      p_user_id: "u1",
      p_bucket: "scan-data-plate",
      p_max: SCAN_DATA_PLATE_LIMIT.max,
      p_window_seconds: SCAN_DATA_PLATE_LIMIT.windowSeconds,
    });
  });

  it("refuses when the counter says the window is spent", async () => {
    rpc.mockResolvedValue({ data: false, error: null });
    await expect(consumeRateLimit("u1", SCAN_DATA_PLATE_LIMIT)).resolves.toBe(false);
  });

  it("FAILS OPEN, and says so, when the RPC does not exist (0076 not applied)", async () => {
    rpc.mockResolvedValue({ data: null, error: { code: "PGRST202", message: "Could not find the function public.consume_rate_limit" } });
    await expect(consumeRateLimit("u1", SCAN_DATA_PLATE_LIMIT)).resolves.toBe(true);
    expect(console.error).toHaveBeenCalledWith(expect.stringMatching(/rate limiter unavailable/), expect.any(String));
  });

  it("fails open on a thrown error too — it is a cost guard, not access control", async () => {
    rpc.mockRejectedValue(new Error("network down"));
    await expect(consumeRateLimit("u1", SCAN_DATA_PLATE_LIMIT)).resolves.toBe(true);
  });
});

const scanReq = (body: Record<string, unknown>) =>
  new NextRequest("http://localhost/api/backflow/scan-data-plate", { method: "POST", body: JSON.stringify(body) });

describe("POST /api/backflow/scan-data-plate — checked before money is spent", () => {
  it("scans a valid JPEG", async () => {
    const res = await scan(scanReq({ imageBase64: "aGVsbG8=", mimeType: "image/jpeg" }));
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("defaults a missing mimeType to JPEG, as older clients rely on", async () => {
    const res = await scan(scanReq({ imageBase64: "aGVsbG8=" }));
    expect(res.status).toBe(200);
    const sent = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(sent.messages[0].content[0].source.media_type).toBe("image/jpeg");
  });

  it.each(["image/gif", "image/heic", "application/pdf", "text/html", 42])("rejects mimeType %s", async (mimeType) => {
    const res = await scan(scanReq({ imageBase64: "aGVsbG8=", mimeType }));
    expect(res.status).toBe(415);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });

  it("rejects an image over 5 MB decoded", async () => {
    const tooBig = "A".repeat(Math.ceil((5 * 1024 * 1024 * 4) / 3) + 8);
    const res = await scan(scanReq({ imageBase64: tooBig, mimeType: "image/png" }));
    expect(res.status).toBe(413);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns 429 without calling Claude once the user's window is spent", async () => {
    rpc.mockResolvedValue({ data: false, error: null });
    const res = await scan(scanReq({ imageBase64: "aGVsbG8=", mimeType: "image/webp" }));
    expect(res.status).toBe(429);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not return the exception text to the client", async () => {
    fetchMock.mockRejectedValue(new Error("connect ECONNREFUSED 10.0.0.1:443 secret-internal-host"));
    const res = await scan(scanReq({ imageBase64: "aGVsbG8=", mimeType: "image/jpeg" }));
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toMatch(/ECONNREFUSED|secret-internal-host/);
  });
});
