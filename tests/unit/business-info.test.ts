import { describe, it, expect, vi } from "vitest";

// business-info reads process.env at module-evaluation time, so each case
// sets env and imports a fresh module copy via vi.resetModules + dynamic import.

async function loadBusinessInfo() {
  const mod = await import("@/lib/business-info");
  return mod.businessInfo;
}

describe("businessInfo", () => {
  it("falls back to the built-in Mellerick defaults when no env vars are set", async () => {
    vi.resetModules();
    for (const k of ["BUSINESS_NAME", "BUSINESS_ABN", "BUSINESS_ADDRESS", "BUSINESS_PHONE", "BUSINESS_EMAIL"]) {
      delete process.env[k];
    }
    const info = await loadBusinessInfo();
    expect(info.name).toBe("Mellerick Pty Ltd");
    expect(info.email).toBe("admin@mellerick.com");
    expect(info.abn).toBeTruthy();
  });

  it("prefers env-var overrides when they are set (Vercel production config)", async () => {
    vi.resetModules();
    process.env.BUSINESS_NAME = "Override Plumbing Pty Ltd";
    process.env.BUSINESS_EMAIL = "accounts@override.example";
    const info = await loadBusinessInfo();
    expect(info.name).toBe("Override Plumbing Pty Ltd");
    expect(info.email).toBe("accounts@override.example");
    delete process.env.BUSINESS_NAME;
    delete process.env.BUSINESS_EMAIL;
  });
});
