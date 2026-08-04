import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import FailureArchiveReporter from "./tests/setup/failure-archive-reporter";

// Path alias mirrors tsconfig's "@/*" -> repo root so tests import app code the
// same way the app does. Two projects: `unit` runs everywhere with no external
// deps (lib logic + mocked route handlers); `rls` (added in Phase 4) needs a
// running local Supabase stack and is opt-in via `npm run test:rls`.
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./", import.meta.url)),
    },
  },
  test: {
    globals: true,
    // Always write a machine-readable record of every run.
    //
    // The web suite has twice reported a single failure and then passed on every
    // subsequent run (Q29). Both times the failing test was NOT identified,
    // because the console output was filtered through a grep that vitest's
    // ANSI-coloured failure block defeats — so an intermittent that had already
    // occurred twice left no evidence either time.
    //
    // The JSON report removes that possibility: whatever fails is recorded with
    // its full name and error, whether or not anyone was watching the terminal.
    // An intermittent you cannot name is one you cannot fix.
    //
    // This path is OVERWRITTEN every run, which on its own defeats the purpose:
    // Q29 fired again on 2026-08-04 (1 failed / 194 passed) and re-running the
    // suite to read the failure erased it. globalTeardown archives failing runs
    // to test-results/failures/ so the next run cannot destroy the evidence.
    reporters: [
      "default",
      ["json", { outputFile: "test-results/unit-results.json" }],
      new FailureArchiveReporter(),
    ],
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          environment: "node",
          include: ["tests/unit/**/*.test.ts"],
          setupFiles: ["tests/setup/unit.ts"],
        },
      },
      {
        extends: true,
        test: {
          name: "rls",
          environment: "node",
          include: ["tests/rls/**/*.test.ts"],
          // Requires a running local Supabase stack (`npm run test:rls`, which
          // boots it). Reads connection details from env — see tests/rls/env.ts.
          testTimeout: 30_000,
          hookTimeout: 60_000,
        },
      },
    ],
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      // Coverage focuses on the pure business-logic and security modules that
      // carry real risk, not repo-wide breadth (per consensus review ADR 0001).
      include: [
        "lib/labour-billing.ts",
        "lib/staff-cost.ts",
        "lib/equipment-cost.ts",
        "lib/xero.ts",
        "lib/business-info.ts",
        "lib/api/**",
      ],
    },
  },
});
