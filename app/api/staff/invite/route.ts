import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/api/guards";
import { createAdminClient } from "@/lib/supabase/admin";
import { appUrl } from "@/lib/env";
import { STAFF_ROLES, alreadyRegistered, normaliseStaffEmail } from "@/lib/staff-invite";

// Invite a new staff member (web Staff page and the phone's Staff screen, with
// a Bearer token). Errors are fixed sentences: GoTrue's own text says whether
// an account exists and names internals — that goes to the server log.
export async function POST(request: NextRequest) {
  try {
    // Server-side enforcement (not just a UI hint): only admins may invite
    // new staff, since the invite form lets the caller pick the role
    // (including "admin"). Without this, anyone who knows the endpoint
    // could POST directly and grant themselves admin access.
    const guard = await requireAdmin(request);
    if (!guard.ok) return guard.response;

    const body = await request.json().catch(() => null);
    const full_name = typeof body?.full_name === "string" ? body.full_name.trim() : "";
    // Stored lowercase so profiles.email matches what Supabase Auth keeps —
    // /api/auth/login keys its lockout on this column.
    const email = normaliseStaffEmail(body?.email);
    const phone = typeof body?.phone === "string" ? body.phone.trim() : "";
    const role = body?.role;

    if (!full_name || !email || !STAFF_ROLES.includes(role)) {
      return NextResponse.json({ error: "Name, a valid email and a role are required" }, { status: 400 });
    }

    const supabaseAdmin = createAdminClient();

    // Create auth user and send invite email
    const { data: authData, error: authError } = await supabaseAdmin.auth.admin.inviteUserByEmail(email, {
      data: { full_name, role },
      // Land the invite on the page that sets a password. Without it the link
      // went to the site root → /dashboard → /login with the tokens ignored,
      // so the new person never got a password and was stuck in a
      // forgot-password loop. /update-password applies the invite's tokens
      // (admin invite links are always implicit — see that page). The app's
      // own origin, never the request Host (a phone's request has none worth
      // trusting).
      redirectTo: `${appUrl()}/update-password`,
    });

    if (authError || !authData?.user) {
      console.error("staff/invite: invite failed", authError);
      return NextResponse.json(
        {
          error: alreadyRegistered(authError?.message)
            ? "Someone with this email already has a login."
            : "The invite could not be sent. Check the email address and try again.",
        },
        { status: 400 }
      );
    }

    // The profile row. handle_new_user() (0044) has usually created it already
    // from the invite metadata, so this is an upsert — a plain insert collided
    // with that row and reported a failed invite for one that had been sent.
    const { error: profileError } = await supabaseAdmin.from("profiles").upsert(
      {
        id: authData.user.id,
        full_name,
        email,
        phone: phone || null,
        role,
        is_active: true,
      },
      { onConflict: "id" }
    );

    if (profileError) {
      console.error("staff/invite: profile insert failed", profileError);
      return NextResponse.json({ error: "The invite was sent, but the staff record could not be saved." }, { status: 500 });
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error("staff/invite: failed", err);
    return NextResponse.json({ error: "Failed to invite user" }, { status: 500 });
  }
}
