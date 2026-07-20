import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

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
