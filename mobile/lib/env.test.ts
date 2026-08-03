import { assertMobileEnv, MISSING_ENV_HELP } from "./env";

// A production build that ships without Supabase credentials is not a degraded
// app — it is a brick. Every screen fails, and the errors point at the network
// layer rather than at the missing configuration, so the cause is the last thing
// anyone looks at.
//
// This is not hypothetical. `mobile/lib/supabase.ts` read
// `process.env.EXPO_PUBLIC_SUPABASE_URL!` — the `!` satisfies TypeScript and
// does nothing at runtime — and NO eas.json build profile declared `env`.
// `.env*` is gitignored, and EAS Cloud builds from a git archive, so the local
// .env never reaches the build. `eas build --profile production`, the documented
// ship path, would have produced an app pointed at `undefined`.
//
// Fail loudly at startup instead. A build that cannot work should say so in the
// first second, naming the variable and how to set it.

describe("assertMobileEnv", () => {
  it("passes when both variables are present", () => {
    expect(() =>
      assertMobileEnv({
        EXPO_PUBLIC_SUPABASE_URL: "https://x.supabase.co",
        EXPO_PUBLIC_SUPABASE_ANON_KEY: "anon-key",
      })
    ).not.toThrow();
  });

  it("throws naming the MISSING variable, not a generic config error", () => {
    expect(() => assertMobileEnv({ EXPO_PUBLIC_SUPABASE_ANON_KEY: "k" })).toThrow(
      /EXPO_PUBLIC_SUPABASE_URL/
    );
  });

  it("names EVERY missing variable at once, so a fix is not one-at-a-time", () => {
    try {
      assertMobileEnv({});
      throw new Error("should have thrown");
    } catch (e) {
      const m = (e as Error).message;
      expect(m).toContain("EXPO_PUBLIC_SUPABASE_URL");
      expect(m).toContain("EXPO_PUBLIC_SUPABASE_ANON_KEY");
    }
  });

  it("treats an EMPTY STRING as missing", () => {
    // `eas env:create` with a blank value, or a shell exporting an unset var,
    // both produce "" — which passes a truthiness check on the key's existence
    // but produces exactly the same broken client.
    expect(() =>
      assertMobileEnv({ EXPO_PUBLIC_SUPABASE_URL: "  ", EXPO_PUBLIC_SUPABASE_ANON_KEY: "k" })
    ).toThrow(/EXPO_PUBLIC_SUPABASE_URL/);
  });

  it("treats the literal string 'undefined' as missing", () => {
    // A shell interpolating an unset variable into eas.json yields the four
    // characters u-n-d-e-f-i-n-e-d, which is truthy and would otherwise sail
    // through to createClient().
    expect(() =>
      assertMobileEnv({
        EXPO_PUBLIC_SUPABASE_URL: "undefined",
        EXPO_PUBLIC_SUPABASE_ANON_KEY: "k",
      })
    ).toThrow(/EXPO_PUBLIC_SUPABASE_URL/);
  });

  it("tells the reader how to fix it, not just what is wrong", () => {
    // The person hitting this is mid-release and does not know that EAS Cloud
    // cannot see a gitignored .env.
    try {
      assertMobileEnv({});
    } catch (e) {
      expect((e as Error).message).toContain(MISSING_ENV_HELP);
    }
  });
});
