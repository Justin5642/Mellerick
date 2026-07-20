import { defineConfig, devices } from "@playwright/test";

// E2E smoke tier. Runs Chromium against a locally-built app pointed at a local
// Supabase stack. To run:
//   1. supabase start            (needs Docker)
//   2. export the app env to point at the local stack
//   3. npx playwright install chromium
//   4. npm run build && npm run test:e2e
//
// BASE_URL lets CI point at an already-running server; otherwise Playwright
// starts `next start` itself.
const BASE_URL = process.env.E2E_BASE_URL ?? "http://127.0.0.1:3000";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  timeout: 30_000,
  use: {
    baseURL: BASE_URL,
    trace: "on-first-retry",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        command: "npm run start",
        url: BASE_URL,
        timeout: 120_000,
        reuseExistingServer: !process.env.CI,
      },
});
