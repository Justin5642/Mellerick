// Connection details for the local Supabase stack the RLS suite runs against.
// Populated by `supabase start` (the CLI prints these). The npm script
// `test:rls` wires them in; when running manually, export them first:
//   SUPABASE_TEST_URL, SUPABASE_TEST_ANON_KEY, SUPABASE_TEST_SERVICE_ROLE_KEY
//
// These MUST point at a local/ephemeral stack — never production. The suite
// creates and deletes users via the admin API.
export const TEST_URL = process.env.SUPABASE_TEST_URL ?? "http://127.0.0.1:54321";
export const TEST_ANON_KEY = process.env.SUPABASE_TEST_ANON_KEY ?? "";
export const TEST_SERVICE_ROLE_KEY = process.env.SUPABASE_TEST_SERVICE_ROLE_KEY ?? "";

export function assertLocalStack(): void {
  if (!TEST_ANON_KEY || !TEST_SERVICE_ROLE_KEY) {
    throw new Error(
      "RLS tests need a local Supabase stack. Run `npm run test:rls` (which boots it) " +
        "or export SUPABASE_TEST_ANON_KEY / SUPABASE_TEST_SERVICE_ROLE_KEY from `supabase status`."
    );
  }
  if (!/127\.0\.0\.1|localhost/.test(TEST_URL)) {
    throw new Error(`Refusing to run RLS tests against a non-local URL: ${TEST_URL}`);
  }
}
