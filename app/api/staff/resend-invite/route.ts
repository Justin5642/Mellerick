import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/api/guards";
import { createAdminClient } from "@/lib/supabase/admin";
import { appUrl } from "@/lib/env";
import { STAFF_ROLES, alreadyRegistered, normaliseStaffEmail } from "@/lib/staff-invite";

// Re-send a staff invite (web Staff page and the phone's Staff screen).
export async function POST(request: NextRequest) {
  try {
    // Same admin-only gate as the initial invite endpoint -- resending an
    // invite still lets the caller set the role in the invite metadata, so
    // it needs the same server-side enforcement, not just a UI hint.
    const guard = await requireAdmin(request);
    if (!guard.ok) return guard.response;

    const body = await request.json().catch(() => null);
    const email = normaliseStaffEmail(body?.email);
    if (!email) {
      return NextResponse.json({ error: "Email is required" }, { status: 400 });
    }
    const full_name = typeof body?.full_name === "string" ? body.full_name : undefined;
    const role = STAFF_ROLES.includes(body?.role) ? body.role : undefined;

    const supabaseAdmin = createAdminClient();

    // Re-sending the invite email is the same call as the original invite --
    // for a user who hasn't accepted yet, Supabase just issues a fresh
    // invite link and re-sends the email. If they've already set a
    // password, this call fails (they're a real registered user now), so we
    // turn that into a clearer message pointing at "Forgot password" instead.
    const { error: authError } = await supabaseAdmin.auth.admin.inviteUserByEmail(email, {
      data: { full_name, role },
      // Land the invite on the page that sets a password (see the invite
      // route). The app's own origin, never the request Host.
      redirectTo: `${appUrl()}/update-password`,
    });

    if (authError) {
      console.error("staff/resend-invite: invite failed", authError);
      return NextResponse.json(
        {
          error: alreadyRegistered(authError.message)
            ? "This person has already accepted their invite and set a password. They should use \"Forgot password\" on the login screen instead."
            : "The invite could not be re-sent. Try again in a minute.",
        },
        { status: 400 }
      );
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error("staff/resend-invite: failed", err);
    return NextResponse.json({ error: "Failed to resend invite" }, { status: 500 });
  }
}
