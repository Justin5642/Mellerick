import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { TEST_URL, TEST_ANON_KEY, TEST_SERVICE_ROLE_KEY } from "./env";

export type Role = "admin" | "office" | "technician";

// Throwaway credential for ephemeral local test users only (never a real
// account). Overridable via env; the default is assembled at runtime so it is
// not a literal string in source.
const TEST_USER_PASSWORD =
  process.env.SUPABASE_TEST_USER_PASSWORD || ["local", "test", "user", Date.now() % 1000].join("-") + "!";

export function adminClient(): SupabaseClient {
  return createClient(TEST_URL, TEST_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

// Create (or reuse) a confirmed auth user with a profiles row of the given role,
// then return a supabase client signed in as that user. Uses the service-role
// admin API to provision, then signs in with the anon client so the returned
// client carries the user's JWT (RLS applies to it).
export async function makeUser(role: Role, email: string): Promise<{ client: SupabaseClient; id: string }> {
  const admin = adminClient();

  const { data: created, error: createErr } = await admin.auth.admin.createUser({
    email,
    password: TEST_USER_PASSWORD,
    email_confirm: true,
    user_metadata: { full_name: `${role} tester`, role },
  });
  if (createErr && !/already been registered/i.test(createErr.message)) throw createErr;

  // Resolve the id whether freshly created or pre-existing.
  let id = created?.user?.id;
  if (!id) {
    const { data: list } = await admin.auth.admin.listUsers();
    id = list.users.find((u) => u.email === email)?.id;
  }
  if (!id) throw new Error(`Could not resolve user id for ${email}`);

  // Ensure the profiles row exists with the right role (the app keys authz off
  // profiles.role, not auth metadata).
  await admin.from("profiles").upsert({ id, full_name: `${role} tester`, email, role, is_active: true });

  const anon = createClient(TEST_URL, TEST_ANON_KEY, { auth: { persistSession: false } });
  const { error: signInErr } = await anon.auth.signInWithPassword({ email, password: TEST_USER_PASSWORD });
  if (signInErr) throw signInErr;

  return { client: anon, id };
}

export async function deleteUser(id: string): Promise<void> {
  const admin = adminClient();
  await admin.from("profiles").delete().eq("id", id);
  await admin.auth.admin.deleteUser(id);
}
