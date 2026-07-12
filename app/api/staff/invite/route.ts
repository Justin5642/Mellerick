import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { createClient as createServerClient } from "@/lib/supabase/server";

export async function POST(request: NextRequest) {
  try {
    // Server-side enforcement (not just a UI hint): only admins may invite
    // new staff, since the invite form lets the caller pick the role
    // (including "admin"). Without this, anyone who knows the endpoint
    // could POST directly and grant themselves admin access.
    const supabaseSession = await createServerClient();
    const { data: { user } } = await supabaseSession.auth.getUser();
    if (!user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
    const { data: requesterProfile } = await supabaseSession
      .from("profiles")
      .select("role")
      .eq("id", user.id)
      .single();
    if (requesterProfile?.role !== "admin") {
      return NextResponse.json({ error: "Only admins can invite staff" }, { status: 403 });
    }

    const { full_name, email, phone, role } = await request.json();

    if (!full_name || !email || !role) {
      return NextResponse.json({ error: "Name, email and role are required" }, { status: 400 });
    }

    const supabaseAdmin = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      { auth: { autoRefreshToken: false, persistSession: false } }
    );

    // Create auth user and send invite email
    const { data: authData, error: authError } = await supabaseAdmin.auth.admin.inviteUserByEmail(email, {
      data: { full_name, role },
    });

    if (authError) return NextResponse.json({ error: authError.message }, { status: 400 });

    // Create profile row
    const { error: profileError } = await supabaseAdmin.from("profiles").insert({
      id: authData.user.id,
      full_name,
      email,
      phone: phone || null,
      role,
      is_active: true,
    });

    if (profileError) return NextResponse.json({ error: profileError.message }, { status: 400 });

    return NextResponse.json({ success: true });
  } catch (err: any) {
    return NextResponse.json({ error: err.message ?? "Failed to invite user" }, { status: 500 });
  }
}
