import { NextResponse } from "next/server";
import { createClient as createServerClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

// Clears the caller's OWN login lockout (migration 0056) after they set a new
// password from an emailed link. Called by /update-password once updateUser()
// succeeds.
//
// Without this a reset did not end the lockout: the 6 failed attempts that
// usually come before a reset kept refusing even the NEW password for up to
// 10 minutes ("Too many failed attempts…"), which staff read as the login
// timing out. Proving control of the inbox is a stronger check than the
// password the lockout exists to protect.
//
// Only ever the signed-in caller's own row: the user id comes from the
// verified session, never from the request body, so this cannot be used to
// unlock someone else. clear_login_lockout is service-role-only (0056).
export async function POST() {
  const supabase = await createServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  const admin = createAdminClient();
  const { error } = await admin.rpc("clear_login_lockout", { p_user_id: user.id });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
