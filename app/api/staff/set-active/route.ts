import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireAdmin } from "@/lib/api/guards";

// Deactivate / reactivate a staff member.
//
// This used to be a client-side `profiles.update({ is_active })`, which only
// flipped a flag nothing on the server read — a deactivated office user kept
// signing in and kept every office right. Doing it here lets us also BAN the
// auth user: Supabase then refuses new sign-ins and token refreshes, so the
// person is out within one access-token lifetime (≤1 hour) even on a device
// that never re-checks the flag. Middleware and lib/api/guards.ts refuse an
// inactive profile immediately on the web; migration 0073 does the same in RLS.

// ~100 years: Supabase has no "forever" ban, and this is what its docs suggest.
const BAN_FOREVER = "876000h";

export async function POST(request: NextRequest) {
  const guard = await requireAdmin(request);
  if (!guard.ok) return guard.response;

  let body: { id?: unknown; active?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }
  const { id, active } = body;
  if (typeof id !== "string" || typeof active !== "boolean") {
    return NextResponse.json({ error: "id and active are required" }, { status: 400 });
  }
  if (id === guard.userId && !active) {
    return NextResponse.json({ error: "You can't deactivate your own account" }, { status: 400 });
  }

  const admin = createAdminClient();

  // Ban first when deactivating: if the profile write then fails the person is
  // still locked out, which is the safe half to leave behind.
  const { error: banError } = await admin.auth.admin.updateUserById(id, {
    ban_duration: active ? "none" : BAN_FOREVER,
  });
  if (banError) {
    console.error("staff/set-active: ban update failed", banError);
    return NextResponse.json({ error: "Could not update this person's login" }, { status: 500 });
  }

  const { error: profileError, count } = await admin
    .from("profiles")
    .update({ is_active: active }, { count: "exact" })
    .eq("id", id);
  if (profileError || count === 0) {
    console.error("staff/set-active: profile update failed", profileError);
    return NextResponse.json({ error: "Could not update this staff member" }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}
