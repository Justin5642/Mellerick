import { NextRequest } from "next/server";
import { createClient as createTokenClient, type SupabaseClient } from "@supabase/supabase-js";
import { createClient as createCookieClient } from "@/lib/supabase/server";

// A Supabase client scoped to the CALLER, for RLS-protected DB access inside a
// route handler — working for BOTH a mobile Bearer token AND a web session
// cookie. This is the piece the invoice/quote send+pdf (and Xero) routes were
// missing: guards.ts already resolves the caller's *identity* from a Bearer
// token, but those routes then built their DB client with the cookie-session
// server client, so a mobile caller was authorized yet its `.from(...)` queries
// ran with no session and RLS rejected them. Use this AFTER authorizing with
// guards.ts (requireOfficeOrAdmin / requireUser).
//
//   • Bearer token present (mobile) → an anon-key client whose Authorization
//     header carries the caller's JWT, so PostgREST applies RLS as that user.
//   • otherwise (web) → the existing cookie-session server client, UNCHANGED —
//     so this can only ADD the mobile path, never alter web behaviour.
export async function callerClient(request: NextRequest): Promise<SupabaseClient> {
  const authHeader = request.headers.get("authorization") ?? "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice("Bearer ".length) : null;

  if (token) {
    return createTokenClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        auth: { autoRefreshToken: false, persistSession: false },
        // apikey stays the anon key; Authorization is overridden with the user's
        // JWT so RLS evaluates as the caller (not anon).
        global: { headers: { Authorization: `Bearer ${token}` } },
      }
    );
  }

  return createCookieClient() as unknown as SupabaseClient;
}
