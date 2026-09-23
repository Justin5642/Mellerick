import { NextRequest, NextResponse } from "next/server";
import { createClient as createServerClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

// Trusted single funnel for both web (app/login/page.tsx) and mobile
// (mobile/lib/auth-context.tsx) sign-in, so the 6-attempts/10-minute lockout
// policy from migration 0055 applies to both platforms even though GoTrue's
// own "Password Verification Attempt" hook can't be enabled on this Supabase
// plan -- see supabase/migrations/0056_app_level_login_lockout.sql for the
// full reasoning.
//
// This route -- not the client -- performs the real signInWithPassword()
// call, and only this route holds the service-role key used to check/record
// lockout state. A client-reported "that attempt failed, please record a
// failure" would let anyone with the public anon key lock out any known
// staff email on purpose, with no valid credentials at all; funnelling
// check + real attempt + record through one trusted request closes that off.
export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  const email = typeof body.email === "string" ? body.email.trim() : "";
  const password = typeof body.password === "string" ? body.password : "";

  if (!email || !password) {
    return NextResponse.json({ error: "Email and password are required." }, { status: 400 });
  }

  const admin = createAdminClient();

  // Looking the profile up first (rather than after a failed sign-in) is
  // what lets a lockout be enforced BEFORE any password is checked at all --
  // matching the 0055 hook, which rejects mid-lockout regardless of whether
  // this attempt's password happens to be correct.
  const { data: profile } = await admin.from("profiles").select("id").eq("email", email).maybeSingle();

  if (profile) {
    const { data: lockout } = await admin.rpc("check_login_lockout", { p_user_id: profile.id });
    if (lockout && (lockout as { locked: boolean; message?: string }).locked) {
      return NextResponse.json({ error: (lockout as { message: string }).message }, { status: 429 });
    }
  }

  // The real check. Uses the cookie-aware server client so a successful web
  // sign-in sets the session cookie as a side effect, exactly as
  // supabase.auth.signInWithPassword() did when called directly from
  // app/login/page.tsx before this route existed.
  const supabase = await createServerClient();
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });

  if (profile) {
    if (error) {
      const { data: result } = await admin.rpc("record_login_failure", { p_user_id: profile.id });
      if (result && (result as { locked: boolean; message?: string }).locked) {
        return NextResponse.json({ error: (result as { message: string }).message }, { status: 429 });
      }
    } else {
      await admin.rpc("clear_login_lockout", { p_user_id: profile.id });
    }
  }

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 401 });
  }

  // Returned so the mobile client (no cookies) can apply the session via
  // supabase.auth.setSession(...). The web client ignores this field -- its
  // session already landed in cookies via the server client above.
  return NextResponse.json({ session: data.session });
}
