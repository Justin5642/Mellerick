import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { getXeroClient } from "@/lib/xero";

// xero-node re-checks the callback's state against config.state and throws
// "checks.state argument is missing" when it was never given one. Every Xero
// reconnect failed that way until 15 Nov 2026, while the old token stayed in use.
describe("Xero OAuth state", () => {
  it("puts the state in the client config, where xero-node checks it", () => {
    expect((getXeroClient("abc123") as unknown as { config: { state?: string } }).config.state).toBe("abc123");
    expect((getXeroClient() as unknown as { config: { state?: string } }).config.state).toBeUndefined();
  });

  it("both ends of the connect flow hand the state to the client", () => {
    const auth = readFileSync("app/api/xero/auth/route.ts", "utf8");
    const callback = readFileSync("app/api/xero/callback/route.ts", "utf8");
    expect(auth).toMatch(/getXeroClient\(state\)/);
    expect(callback).toMatch(/getXeroClient\(state!?\)/);
  });
});
