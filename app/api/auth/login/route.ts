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
//
// A SPEED BUMP, NOT A WALL. The anon key ships in every client, so anyone can
// call Supabase Auth's /token endpoint directly and never pass through here.
// This lockout slows guessing through the app's own login screens; the real
// backstops are Supabase's own per-IP auth rate limits and decent passwords.
// Do not cite it as brute-force protection for the project as a whole.

// One answer for every refused sign-in — wrong password, unknown email, AND an
// account mid-lockout. Distinct answers let anyone probe which staff emails
// exist (only a real account can ever be locked) and confirm when a guessing
// run has tripped the lockout. The cost: a person who is locked out and then
// types the RIGHT password is told it is wrong. The second sentence is there
// for exactly them — it says sign-in pauses and how to get straight back in.
//
// Not fully indistinguishable: a locked account answers without the
// signInWithPassword round trip, so it is faster. Running the real check
// during a lockout and discarding the result would close that, but a correct
// password would then set the session cookie as a side effect — so the
// timing difference is accepted.
const SIGN_IN_REFUSED =
  'Incorrect email or password. After 6 failed attempts in a row sign-in pauses for 10 minutes — use "Forgot password?" to reset it by email now.';

function refused() {
  return NextResponse.json({ error: SIGN_IN_REFUSED }, { status: 401 });
}

// profiles.email is matched case-insensitively because Supabase Auth is:
// `Admin@x` signs in to the `admin@x` account. An exact `.eq` missed the
// profile for any other casing, which skipped the lockout check AND the
// failure count entirely — unlimited guesses just by changing one letter.
//
// ilike, with LIKE's own wildcards escaped, then an exact lowercase compare
// in JS: PostgREST also treats `*` as a wildcard in like patterns and an
// email may legally contain one, so the database narrows and JS decides.
async function findProfileId(admin: ReturnType<typeof createAdminClient>, email: string): Promise<string | null> {
  const pattern = email.replace(/[\\%_]/g, "\\$&");
  const { data } = await admin.from("profiles").select("id, email").ilike("email", pattern).limit(10);
  const match = (data ?? []).find((p: { email: string | null }) => p.email?.trim().toLowerCase() === email);
  return match?.id ?? null;
}

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  // Normalised once, here: the lockout lookup and the real sign-in must agree
  // on which account an attempt belongs to.
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const password = typeof body.password === "string" ? body.password : "";

  if (!email || !password) {
    return NextResponse.json({ error: "Email and password are required." }, { status: 400 });
  }

  const admin = createAdminClient();

  // Looking the profile up first (rather than after a failed sign-in) is
  // what lets a lockout be enforced BEFORE any password is checked at all --
  // matching the 0055 hook, which rejects mid-lockout regardless of whether
  // this attempt's password happens to be correct.
  const profileId = await findProfileId(admin, email);

  if (profileId) {
    const { data: lockout } = await admin.rpc("check_login_lockout", { p_user_id: profileId });
    if (lockout && (lockout as { locked: boolean }).locked) return refused();
  }

  // The real check. Uses the cookie-aware server client so a successful web
  // sign-in sets the session cookie as a side effect, exactly as
  // supabase.auth.signInWithPassword() did when called directly from
  // app/login/page.tsx before this route existed.
  const supabase = await createServerClient();
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });

  if (profileId) {
    if (error) {
      await admin.rpc("record_login_failure", { p_user_id: profileId });
    } else {
      await admin.rpc("clear_login_lockout", { p_user_id: profileId });
    }
  }

  if (error) {
    // GoTrue's own text ("Invalid login credentials", "Email not confirmed",
    // …) stays in the server log: some of it is account-specific. An outage
    // is not, so it gets its own answer rather than "wrong password".
    console.error("Sign-in refused:", error.status, error.message);
    if (!error.status || error.status >= 500) {
      return NextResponse.json({ error: "Sign-in is temporarily unavailable. Try again shortly." }, { status: 503 });
    }
    // Supabase's auth rate limit is per IP, not per account, so saying so
    // reveals nothing about which emails exist.
    if (error.status === 429) {
      return NextResponse.json({ error: "Too many sign-in attempts from this network. Try again shortly." }, { status: 429 });
    }
    return refused();
  }

  // Returned so the mobile client (no cookies) can apply the session via
  // supabase.auth.setSession(...). The web client ignores this field -- its
  // session already landed in cookies via the server client above.
  return NextResponse.json({ session: data.session });
}
