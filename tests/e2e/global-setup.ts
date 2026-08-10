import { chromium, type FullConfig } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { seed, OFFICE_EMAIL, TECH_EMAIL, type SeedUser } from "./fixtures/seed";
import { OFFICE_STATE, TECH_STATE, SEED_FILE } from "./fixtures/paths";

// Runs once before the e2e suite.
//
// Seeds the local stack, then signs in as each role THROUGH THE REAL LOGIN FORM
// and saves the resulting browser state. Two reasons it logs in through the UI
// rather than minting a session with the API:
//
//   1. It is the only place the login form itself gets exercised. Every other
//      test starts already authenticated, so a broken sign-in would otherwise
//      surface as every test failing for an unrelated-looking reason.
//   2. The app stores its session through @supabase/ssr, and reproducing that
//      storage by hand would be a second implementation of the thing under
//      test. Driving the form gets whatever the app actually writes.
//
// The generated passwords exist only in this process's memory. What reaches the
// tests is a storageState file — a session, not a credential — written under
// test-results/, which is gitignored.
export default async function globalSetup(config: FullConfig) {
  const office: SeedUser = {
    email: OFFICE_EMAIL,
    secret: randomUUID(),
    fullName: "E2E Office",
    role: "office",
  };
  const tech: SeedUser = {
    email: TECH_EMAIL,
    secret: randomUUID(),
    fullName: "E2E Technician",
    role: "technician",
  };

  // assertLocalStack() fires in here if the URL is not loopback, before any
  // user is created.
  const seeded = await seed(office, tech);

  mkdirSync(dirname(SEED_FILE), { recursive: true });
  writeFileSync(SEED_FILE, JSON.stringify(seeded, null, 2));

  const baseURL = config.projects[0]?.use?.baseURL ?? "http://127.0.0.1:3000";
  const browser = await chromium.launch();
  try {
    await signIn(browser, baseURL, office, OFFICE_STATE);
    await signIn(browser, baseURL, tech, TECH_STATE);
  } finally {
    await browser.close();
  }
}

async function signIn(
  browser: Awaited<ReturnType<typeof chromium.launch>>,
  baseURL: string,
  user: SeedUser,
  statePath: string
) {
  const context = await browser.newContext({ baseURL });
  const page = await context.newPage();
  await page.goto("/login");
  await page.getByPlaceholder("you@example.com").fill(user.email);
  await page.locator("#password").fill(user.secret);
  await page.getByRole("button", { name: /sign in/i }).click();

  // A technician is redirected off /dashboard by middleware, so wait for "any
  // dashboard route" rather than the exact one — otherwise this setup encodes
  // the very routing rule the tests are meant to check.
  await page.waitForURL(/\/dashboard(\/|$)/, { timeout: 20_000 });

  mkdirSync(dirname(statePath), { recursive: true });
  await context.storageState({ path: statePath });
  await context.close();
}
