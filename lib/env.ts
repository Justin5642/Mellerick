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
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
  }
}
