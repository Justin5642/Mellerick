import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/api/guards";
import { createAdminClient } from "@/lib/supabase/admin";
import { STAFF_ROLES, alreadyRegistered, normaliseStaffEmail } from "@/lib/staff-invite";

// Edit a staff member's name, login email, phone and role (web Staff page and
// the phone's Staff screen).
export async function POST(request: NextRequest) {
  try {
    // Same admin-only gate as invite/resend-invite -- this endpoint can
    // change a staff member's role (including granting admin), so it must be
    // enforced server-side, not just hidden behind a UI check.
    const guard = await requireAdmin(request);
    if (!guard.ok) return guard.response;

    const body = await request.json().catch(() => null);
    const id = typeof body?.id === "string" ? body.id : "";
    const full_name = typeof body?.full_name === "string" ? body.full_name.trim() : "";
    // Stored lowercase, as invites store it — /api/auth/login keys its
    // lockout on profiles.email.
    const email = normaliseStaffEmail(body?.email);
    const phone = typeof body?.phone === "string" ? body.phone.trim() : "";
    const role = body?.role;

    if (!id || !full_name || !email || !STAFF_ROLES.includes(role)) {
      return NextResponse.json({ error: "Name, a valid email and a role are required" }, { status: 400 });
    }

    const supabaseAdmin = createAdminClient();

    // profiles.email mirrors the real Supabase Auth login email that was set
    // when the invite was sent. If the email is changing, update the Auth
    // user too -- otherwise the displayed email would desync from the actual
    // login credential.
    const { data: existingProfile, error: existingError } = await supabaseAdmin
      .from("profiles")
      .select("email")
      .eq("id", id)
      .single();

    if (existingError || !existingProfile) {
      console.error("staff/update: profile read failed", existingError);
      return NextResponse.json({ error: "Staff member not found" }, { status: 404 });
    }

    if ((existingProfile.email ?? "").toLowerCase() !== email) {
      const { error: authUpdateError } = await supabaseAdmin.auth.admin.updateUserById(id, { email });
      if (authUpdateError) {
        console.error("staff/update: login email update failed", authUpdateError);
        return NextResponse.json(
          {
            error: alreadyRegistered(authUpdateError.message)
              ? "Another login already uses this email."
              : "The login email could not be changed. Nothing was saved.",
          },
          { status: 400 }
        );
      }
    }

    const { error: profileError } = await supabaseAdmin
      .from("profiles")
      .update({ full_name, email, phone: phone || null, role })
      .eq("id", id);

    if (profileError) {
      console.error("staff/update: profile update failed", profileError);
      return NextResponse.json({ error: "Could not update this staff member" }, { status: 500 });
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error("staff/update: failed", err);
    return NextResponse.json({ error: "Failed to update staff member" }, { status: 500 });
  }
}
