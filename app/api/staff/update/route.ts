import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { createClient as createServerClient } from "@/lib/supabase/server";

export async function POST(request: NextRequest) {
  try {
    // Same admin-only gate as invite/resend-invite -- this endpoint can
    // change a staff member's role (including granting admin), so it must be
    // enforced server-side, not just hidden behind a UI check.
    const supabaseSession = await createServerClient();
    const { data: { user } } = await supabaseSession.auth.getUser();
    if (!user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
    const { data: requesterProfile } = await supabaseSession
      .from("profiles")
      .select("role")
      .eq("id", user.id)
      .single();
    if (requesterProfile?.role !== "admin") {
      return NextResponse.json({ error: "Only admins can edit staff" }, { status: 403 });
    }

    const { id, full_name, email, phone, role } = await request.json();

    if (!id || !full_name || !email || !role) {
      return NextResponse.json({ error: "Name, email and role are required" }, { status: 400 });
    }

    const supabaseAdmin = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      { auth: { autoRefreshToken: false, persistSession: false } }
    );

    // profiles.email mirrors the real Supabase Auth login email that was set
    // when the invite was sent. If the email is changing, update the Auth
    // user too -- otherwise the displayed email would desync from the actual
    // login credential.
    const { data: existingProfile, error: existingError } = await supabaseAdmin
      .from("profiles")
      .select("email")
      .eq("id", id)
      .single();

    if (existingError) return NextResponse.json({ error: existingError.message }, { status: 400 });

    if (existingProfile.email !== email) {
      const { error: authUpdateError } = await supabaseAdmin.auth.admin.updateUserById(id, { email });
      if (authUpdateError) return NextResponse.json({ error: authUpdateError.message }, { status: 400 });
    }

    const { error: profileError } = await supabaseAdmin
      .from("profiles")
      .update({ full_name, email, phone: phone || null, role })
      .eq("id", id);

    if (profileError) return NextResponse.json({ error: profileError.message }, { status: 400 });

    return NextResponse.json({ success: true });
  } catch (err: any) {
    return NextResponse.json({ error: err.message ?? "Failed to update staff member" }, { status: 500 });
  }
}
