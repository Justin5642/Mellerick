import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Lint is enforced during builds (and in CI). Rules are tuned in
  // eslint.config.mjs so the build fails only on genuine errors, not on the
  // codebase's deliberate `any` convention (surfaced as warnings instead).
  eslint: {
    dirs: ["app", "components", "lib"],
  },
};

export default nextConfig;
