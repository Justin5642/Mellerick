import type { NextConfig } from "next";
import { assertRequiredEnv } from "./lib/env";

// Fail fast, and legibly, on a misconfigured deployment.
//
// This exists because of a real incident: preview deployments failed for weeks
// with "Error occurred prerendering page /forgot-password — @supabase/ssr: Your
// project's URL and API key are required to create a Supabase client!". That
// names neither the missing variable nor the environment it was missing from,
// and it points at a password-reset page that had nothing to do with the cause.
// lib/env.ts had assertRequiredEnv() written for precisely this, and nothing
// ever called it.
//
// It runs here rather than in instrumentation.ts — which the comment in
// lib/env.ts suggested, and which does NOT work: Next never invokes register()
// during the static export pass, so the build still died with the opaque
// message (verified against this repo, not assumed). next.config is loaded
// after Next reads the .env files and before compilation, so the check lands
// early and names the problem.
//
// It throws rather than warns deliberately. NEXT_PUBLIC_* values are inlined
// into the client bundle at build time, so a build that completed without them
// would ship a sign-in page calling createBrowserClient(undefined, undefined) —
// moving the failure from CI, where someone sees it, to the user's browser,
// where nobody does.
assertRequiredEnv();

const nextConfig: NextConfig = {
  // Lint is enforced during builds (and in CI). Rules are tuned in
  // eslint.config.mjs so the build fails only on genuine errors, not on the
  // codebase's deliberate `any` convention (surfaced as warnings instead).
  eslint: {
    dirs: ["app", "components", "lib"],
  },
};

export default nextConfig;
