// Fail loudly when the app is built without Supabase credentials.
//
// THE FAILURE THIS PREVENTS. `lib/supabase.ts` read
// `process.env.EXPO_PUBLIC_SUPABASE_URL!`. The `!` satisfies TypeScript and does
// nothing at runtime, so a missing value produced `createClient(undefined,
// undefined)` — an app that installs, launches, renders, and then fails every
// single request with errors that point at the network layer rather than at the
// missing configuration.
//
// And it was reachable by the documented ship path. NO eas.json build profile
// declared `env`; `.env*` is gitignored; EAS Cloud builds from a git archive, so
// the local .env never reaches the builder. `eas build --profile production`
// would have produced exactly that brick, and the first person to find out would
// have been a technician on a roof.
//
// Expo inlines EXPO_PUBLIC_* at BUILD time, so this cannot be checked in CI
// against the built artifact without unpacking it — the honest place to check is
// the first moment the app runs.

export const MISSING_ENV_HELP =
  "EAS Cloud builds from a git archive and .env* is gitignored, so a local .env " +
  "does NOT reach the build. Set these as EAS environment variables " +
  "(`eas env:create --scope project`) or add an `env` block to the build profile " +
  "in mobile/eas.json. For a local run, mobile/.env is enough.";

const REQUIRED = ["EXPO_PUBLIC_SUPABASE_URL", "EXPO_PUBLIC_SUPABASE_ANON_KEY"] as const;

function isMissing(value: string | undefined): boolean {
  if (value === undefined || value === null) return true;
  const trimmed = String(value).trim();
  // "" is what a blank `eas env:create` or an unset shell variable produces, and
  // the literal "undefined" is what string interpolation of an unset variable
  // produces. Both are truthy enough to reach createClient() and break there
  // instead of here.
  return trimmed === "" || trimmed === "undefined" || trimmed === "null";
}

/**
 * Throw unless every required public variable is genuinely set.
 *
 * Takes the environment as an argument so it is testable; the runtime call site
 * passes `process.env`.
 */
export function assertMobileEnv(env: Record<string, string | undefined>): void {
  const missing = REQUIRED.filter((key) => isMissing(env[key]));
  if (missing.length === 0) return;

  // Every missing name at once. Reporting them one at a time turns a single
  // misconfiguration into several build-fix-rebuild cycles.
  throw new Error(
    `Mellerick Field cannot start: missing ${missing.join(", ")}.\n\n${MISSING_ENV_HELP}`
  );
}
