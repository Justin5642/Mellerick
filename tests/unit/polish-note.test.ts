import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// The polish route is a paid AI call open to every signed-in user, so it must
// cap input size BEFORE calling the model; and the shared helper runs on Haiku,
// retrying once on Opus only if Haiku declines.

const create = vi.fn();

vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = { create: (...a: unknown[]) => create(...a) };
  },
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: "u1" } } }) } }),
}));

// The shared per-user limiter (lib/api/rate-limit.ts). Mocked so the route
// never reaches for a real database; `allowed` flips it per test.
let allowed = true;
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ rpc: async () => ({ data: allowed, error: null }) }),
}));

function reply(text: string, stop_reason = "end_turn") {
  return { stop_reason, content: text ? [{ type: "text", text }] : [] };
}

function post(text: string) {
  return new NextRequest("http://localhost/api/ai/polish-note", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text }),
  });
}

beforeEach(() => {
  create.mockReset();
  allowed = true;
  process.env.ANTHROPIC_API_KEY = "test-key";
});

describe("polishNoteText", () => {
  it("polishes on Haiku and returns the text", async () => {
    create.mockResolvedValueOnce(reply("Replaced the TMV."));
    const { polishNoteText } = await import("@/lib/ai/polish-note");
    await expect(polishNoteText("replaced the tmv")).resolves.toBe("Replaced the TMV.");
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0][0].model).toBe("claude-haiku-5-5");
  });

  it("retries once on Opus when Haiku declines", async () => {
    create.mockResolvedValueOnce(reply("", "refusal")).mockResolvedValueOnce(reply("Fixed it."));
    const { polishNoteText } = await import("@/lib/ai/polish-note");
    await expect(polishNoteText("fixed it")).resolves.toBe("Fixed it.");
    expect(create.mock.calls.map((c) => c[0].model)).toEqual(["claude-haiku-5-5", "claude-opus-5-5"]);
  });

  it("throws when both models decline", async () => {
    create.mockResolvedValue(reply("", "refusal"));
    const { polishNoteText } = await import("@/lib/ai/polish-note");
    await expect(polishNoteText("x")).rejects.toThrow("declined");
  });
});

describe("POST /api/ai/polish-note", () => {
  it("rejects an over-long note without calling the model", async () => {
    const { POST } = await import("@/app/api/ai/polish-note/route");
    const { POLISH_MAX_CHARS } = await import("@/lib/ai/polish-note");
    const res = await POST(post("a".repeat(POLISH_MAX_CHARS + 1)));
    expect(res.status).toBe(413);
    expect(create).not.toHaveBeenCalled();
  });

  it("returns 429 without calling the model once the user's window is spent", async () => {
    allowed = false;
    const { POST } = await import("@/app/api/ai/polish-note/route");
    const res = await POST(post("fixed the tap"));
    expect(res.status).toBe(429);
    expect(create).not.toHaveBeenCalled();
  });

  it("does not pass the SDK's error text through to the client", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    create.mockRejectedValue(new Error("401 invalid x-api-key sk-ant-REDACTED"));
    const { POST } = await import("@/app/api/ai/polish-note/route");
    const res = await POST(post("fixed the tap"));
    expect(res.status).toBe(502);
    expect((await res.json()).error).toBe("AI polish failed");
  });

  it("accepts a note at the limit", async () => {
    create.mockResolvedValueOnce(reply("ok"));
    const { POST } = await import("@/app/api/ai/polish-note/route");
    const { POLISH_MAX_CHARS } = await import("@/lib/ai/polish-note");
    const res = await POST(post("a".repeat(POLISH_MAX_CHARS)));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ polished: "ok" });
  });
});
