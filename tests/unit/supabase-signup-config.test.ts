import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

// Public sign-up is off. The app never calls signUp(): staff arrive by admin
// invite (inviteUserByEmail, which GoTrue's signup switch does not gate) and
// tests use auth.admin.createUser. Left on, anyone with the public anon key
// could mint themselves an authenticated session.
//
// This file only governs the LOCAL stack; the hosted project's switch is in the
// Dashboard (HANDOVER §7).

function section(toml: string, name: string): string {
  const start = toml.indexOf(`\n[${name}]\n`);
  expect(start, `[${name}] missing from config.toml`).toBeGreaterThan(-1);
  const rest = toml.slice(start + name.length + 4);
  const next = rest.search(/\n\[/);
  return next === -1 ? rest : rest.slice(0, next);
}

const toml = readFileSync("supabase/config.toml", "utf8");

describe("supabase/config.toml", () => {
  it("[auth] enable_signup is false", () => {
    expect(section(toml, "auth")).toMatch(/^enable_signup = false$/m);
  });

  it("[auth.email] enable_signup stays true — the CLI maps it to the whole email provider", () => {
    // GOTRUE_EXTERNAL_EMAIL_ENABLED: false would break every password sign-in
    // locally and in CI, not just sign-up.
    expect(section(toml, "auth.email")).toMatch(/^enable_signup = true$/m);
  });
});
