import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// The ONE place the service-role key is turned into a client. This key bypasses
// all row-level security, so keeping its construction in a single grep-able
// module (rather than inlined per-route) makes it auditable and gives tests a
// single seam to mock. Only ever call this AFTER authorizing the caller — see
// lib/api/guards.ts. Never import this into client components.
//
// `headers` are sent on every request this client makes; Postgres sees them as
// current_setting('request.headers'). Used to mark a service-role write as a
// real user action (see /api/jobs/[id]/set-assignments, and migration 0077 —
// a draft, not applied yet).
export function createAdminClient(options?: { headers?: Record<string, string> }): SupabaseClient {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    {
      auth: { autoRefreshToken: false, persistSession: false },
      ...(options?.headers ? { global: { headers: options.headers } } : {}),
    }
  );
}
