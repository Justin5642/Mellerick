import { describe, it, expect, vi } from "vitest";
import { buildMessages, chunk, sendExpoPush } from "@/supabase/functions/send-push/pushSender";

const notif = { title: "New job", body: "You've been assigned a job", data: { jobId: "j1" } };

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body } as unknown as Response;
}

describe("buildMessages", () => {
  it("keeps only well-formed Expo tokens and stamps the notification", () => {
    const msgs = buildMessages(["ExponentPushToken[a]", "garbage", "ExpoPushToken[b]", ""], notif);
    expect(msgs.map((m) => m.to)).toEqual(["ExponentPushToken[a]", "ExpoPushToken[b]"]);
    expect(msgs[0]).toMatchObject({ title: "New job", body: "You've been assigned a job", data: { jobId: "j1" } });
  });
});

describe("chunk", () => {
  it("splits into batches of at most 100", () => {
    const c = chunk(Array.from({ length: 250 }, (_, i) => i));
    expect(c.map((b) => b.length)).toEqual([100, 100, 50]);
  });
});

describe("sendExpoPush", () => {
  it("no-ops with zero valid tokens (no fetch)", async () => {
    const fetchFn = vi.fn();
    const res = await sendExpoPush(fetchFn as unknown as typeof fetch, ["not-a-token"], notif);
    expect(res).toEqual({ sent: 0, failed: 0, invalidTokens: [], errors: [] });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("counts ok tickets as sent", async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ data: [{ status: "ok" }, { status: "ok" }] }));
    const res = await sendExpoPush(fetchFn as unknown as typeof fetch, ["ExponentPushToken[a]", "ExponentPushToken[b]"], notif);
    expect(res.sent).toBe(2);
    expect(res.failed).toBe(0);
  });

  it("surfaces DeviceNotRegistered tokens for pruning", async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse({ data: [{ status: "ok" }, { status: "error", message: "gone", details: { error: "DeviceNotRegistered" } }] })
    );
    const res = await sendExpoPush(fetchFn as unknown as typeof fetch, ["ExponentPushToken[a]", "ExponentPushToken[b]"], notif);
    expect(res.sent).toBe(1);
    expect(res.failed).toBe(1);
    expect(res.invalidTokens).toEqual(["ExponentPushToken[b]"]);
  });

  it("records an HTTP failure without throwing", async () => {
    const fetchFn = vi.fn(async () => jsonResponse({}, false, 502));
    const res = await sendExpoPush(fetchFn as unknown as typeof fetch, ["ExponentPushToken[a]"], notif);
    expect(res.failed).toBe(1);
    expect(res.errors).toContain("HTTP 502");
  });

  it("records a network error without throwing", async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error("network down");
    });
    const res = await sendExpoPush(fetchFn as unknown as typeof fetch, ["ExponentPushToken[a]"], notif);
    expect(res.failed).toBe(1);
    expect(res.errors).toContain("network down");
  });

  it("batches >100 tokens across multiple requests", async () => {
    const fetchFn = vi.fn(async (_url: string, init?: RequestInit) => {
      const batch = JSON.parse(String(init?.body)) as unknown[];
      return jsonResponse({ data: batch.map(() => ({ status: "ok" })) });
    });
    const tokens = Array.from({ length: 150 }, (_, i) => `ExponentPushToken[${i}]`);
    const res = await sendExpoPush(fetchFn as unknown as typeof fetch, tokens, notif);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(res.sent).toBe(150);
  });
});
