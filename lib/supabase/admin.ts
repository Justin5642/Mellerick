import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// The ONE place the service-role key is turned into a client. This key bypasses
// all row-level security, so keeping its construction in a single grep-able
// module (rather than inlined per-route) makes it auditable and gives tests a
// single seam to mock. Only ever call this AFTER authorizing the caller — see
// lib/api/guards.ts. Never import this into client components.
export function createAdminClient(): SupabaseClient {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  );
}
