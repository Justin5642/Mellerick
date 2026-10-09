import type { NextConfig } from "next";
import { withSentryConfig } from "@sentry/nextjs/config";
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

// Response headers the app had none of (item 3.5). Deliberately conservative:
// every one of these can break a working page if set too tightly, and this app
// serves PDFs, signed Supabase Storage URLs and Google OAuth redirects.
//
// NOT SET, and why — so the next person does not read the omission as an
// oversight:
//   Content-Security-Policy  Next injects inline scripts for hydration, and a
//                            CSP without 'unsafe-inline' or a nonce pipeline
//                            breaks the app outright. Worth doing, but it needs
//                            a report-only rollout against real traffic first,
//                            not a guess in a config file.
//   HSTS                     Vercel already serves it on the apex domain, and
//                            setting max-age wrong is the one header you cannot
//                            walk back — browsers honour it after the fix.
const securityHeaders = [
  // Stops a browser second-guessing a declared Content-Type. The real target is
  // uploaded files served back to a user: a .png that is actually HTML must not
  // be sniffed into a script.
  { key: "X-Content-Type-Options", value: "nosniff" },
  // No third party frames this app, so clickjacking has no surface to work
  // with. DENY rather than SAMEORIGIN because nothing here frames itself.
  { key: "X-Frame-Options", value: "DENY" },
  // Referrers leak URLs, and this app's URLs contain job, invoice and customer
  // ids. Same-origin gets the full path; anyone else gets the origin only.
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  // The app never uses these, so denying them means a compromised dependency
  // cannot start.
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
];

const nextConfig: NextConfig = {
  // Removes the `X-Powered-By: Next.js` version advertisement.
  poweredByHeader: false,

  // Always define the Sentry DSN at build time, as "" when unset. Next only
  // inlines NEXT_PUBLIC_* variables that EXIST; an unset one is left as a
  // runtime lookup, which the bundler cannot fold — so every
  // `if (process.env.NEXT_PUBLIC_SENTRY_DSN)` guard stayed live and the whole
  // SDK (~85 kB) shipped to every browser even with monitoring off. Defined as
  // "", those branches are dead code and the SDK is dropped from the bundle.
  env: { NEXT_PUBLIC_SENTRY_DSN: process.env.NEXT_PUBLIC_SENTRY_DSN ?? "" },

  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },

  // Lint is enforced during builds (and in CI). Rules are tuned in
  // eslint.config.mjs so the build fails only on genuine errors, not on the
  // codebase's deliberate `any` convention (surfaced as warnings instead).
  eslint: {
    dirs: ["app", "components", "lib"],
  },
};

// Error monitoring (Sentry) — optional, see HANDOVER §12.
//
// Only wrapped when NEXT_PUBLIC_SENTRY_DSN is set, so a deployment without it
// (local dev, CI, a Vercel environment that has not opted in) builds with
// exactly the config above and nothing else. Source maps are uploaded only when
// SENTRY_AUTH_TOKEN, SENTRY_ORG and SENTRY_PROJECT are ALL present; otherwise
// the upload step is disabled outright rather than warning on every build.
// Maps are deleted from the output after upload, so they are never served.
function withMonitoring(config: NextConfig): NextConfig {
  if (!process.env.NEXT_PUBLIC_SENTRY_DSN) return config;
  const canUpload = Boolean(
    process.env.SENTRY_AUTH_TOKEN && process.env.SENTRY_ORG && process.env.SENTRY_PROJECT
  );
  return withSentryConfig(config, {
    org: process.env.SENTRY_ORG,
    project: process.env.SENTRY_PROJECT,
    authToken: process.env.SENTRY_AUTH_TOKEN,
    silent: !process.env.CI,
    telemetry: false,
    sourcemaps: { disable: !canUpload, deleteSourcemapsAfterUpload: true },
    // Without a token there is nothing to create a release against.
    release: { create: canUpload },
    widenClientFileUpload: canUpload,
    // The plugin's default is to FAIL THE BUILD when an upload errors (bad
    // token, Sentry outage). Monitoring must never be the reason a production
    // deploy does not ship, so log and carry on.
    errorHandler: (err) => {
      console.warn(`[sentry] source-map upload failed, continuing build: ${err.message}`);
    },
  });
}

export default withMonitoring(nextConfig);
