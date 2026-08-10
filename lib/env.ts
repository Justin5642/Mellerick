// Central, typed access to environment variables with fail-fast validation.
//
// Two tiers:
//  - REQUIRED: the app cannot function without these (Supabase). Reading one
//    that's missing throws immediately with a clear message, rather than the
//    opaque runtime errors you get from `process.env.X!` deep inside a request.
//  - OPTIONAL: feature-gated integrations (Xero, Google, Resend, OpenAI,
//    Anthropic, business info). Missing values return undefined so callers can
//    degrade gracefully / show "not connected".
//
// Existing routes still read process.env directly; migrate them to these
// accessors incrementally. `assertRequiredEnv()` can be called at startup
// (e.g. instrumentation.ts) to fail fast on a misconfigured deployment.

const REQUIRED_VARS = [
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
] as const;

// Required only in server contexts that use the service-role client. Not in the
// always-required list because client bundles never see it.
const SERVER_REQUIRED_VARS = ["SUPABASE_SERVICE_ROLE_KEY"] as const;

type RequiredVar = (typeof REQUIRED_VARS)[number] | (typeof SERVER_REQUIRED_VARS)[number];

export function requireEnv(name: RequiredVar): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing required environment variable ${name}. ` +
        `Set it in .env.local (see .env.example) or the Vercel project settings.`
    );
  }
  return value;
}

export function optionalEnv(name: string): string | undefined {
  return process.env[name] || undefined;
}

// Fail-fast check for the always-required public vars. Returns the list of
// missing names (empty if all present) so a caller can log/throw as it prefers.
export function missingRequiredEnv(): string[] {
  return REQUIRED_VARS.filter((name) => !process.env[name]);
}

export function assertRequiredEnv(): void {
  const missing = missingRequiredEnv();
  if (missing.length === 0) return;

  // Name the fix, not just the fault. next.config.ts records that preview
  // deployments "failed for weeks" on this, and the message that replaced the
  // opaque Supabase one still left the reader to work out WHERE to set the
  // variable — so a Vercel Preview build has gone on failing every pull
  // request while Production, which does have the values, builds fine. That
  // asymmetry is the tell, and it is worth spelling out rather than
  // rediscovering a third time.
  //
  // Vercel scopes variables per environment: setting them for Production does
  // NOT set them for Preview. Both need them, because NEXT_PUBLIC_* values are
  // inlined into the client bundle at build time.
  throw new Error(
    `Missing required environment variables: ${missing.join(", ")}\n\n` +
      `Locally: add them to .env.local (see .env.example).\n` +
      `On Vercel: Project Settings -> Environment Variables, and tick BOTH ` +
      `Production AND Preview. A Preview deployment does not inherit ` +
      `Production values, so a project that deploys fine to production will ` +
      `still fail every pull request.\n` +
      `In CI: .github/workflows/ci.yml supplies dummy values for this reason.`
  );
}
