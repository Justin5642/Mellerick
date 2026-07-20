import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { requireEnv, optionalEnv, missingRequiredEnv, assertRequiredEnv } from "@/lib/env";

describe("env accessors", () => {
  const saved = { ...process.env };
  beforeEach(() => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://x.supabase.co";
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "svc";
  });
  afterEach(() => {
    process.env = { ...saved };
  });

  it("returns a required var when present", () => {
    expect(requireEnv("NEXT_PUBLIC_SUPABASE_URL")).toBe("https://x.supabase.co");
  });

  it("throws a clear error naming the missing required var", () => {
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    expect(() => requireEnv("SUPABASE_SERVICE_ROLE_KEY")).toThrowError(/SUPABASE_SERVICE_ROLE_KEY/);
  });

  it("returns undefined for an unset optional var (no throw)", () => {
    delete process.env.RESEND_API_KEY;
    expect(optionalEnv("RESEND_API_KEY")).toBeUndefined();
  });

  it("reports and asserts the required public vars", () => {
    expect(missingRequiredEnv()).toEqual([]);
    expect(() => assertRequiredEnv()).not.toThrow();

    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    expect(missingRequiredEnv()).toContain("NEXT_PUBLIC_SUPABASE_URL");
    expect(() => assertRequiredEnv()).toThrowError(/NEXT_PUBLIC_SUPABASE_URL/);
  });
});
