import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { createClient as createServerClient } from "@/lib/supabase/server";

export async function POST(request: NextRequest) {
  try {
    // Same admin-only gate as the initial invite endpoint -- resending an
    // invite still lets the caller set the role in the invite metadata, so
    // it needs the same server-side enforcement, not just a UI hint.
    const supabaseSession = await createServerClient();
    const { data: { user } } = await supabaseSession.auth.getUser();
    if (!user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
    const { data: requesterProfile } = await supabaseSession
      .from("profiles")
      .select("role")
      .eq("id", user.id)
      .single();
    if (requesterProfile?.role !== "admin") {
      return NextResponse.json({ error: "Only admins can resend invites" }, { status: 403 });
    }

    const { email, full_name, role } = await request.json();
    if (!email) {
      return NextResponse.json({ error: "Email is required" }, { status: 400 });
    }

    const supabaseAdmin = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      { auth: { autoRefreshToken: false, persistSession: false } }
    );

    // Re-sending the invite email is the same call as the original invite --
    // for a user who hasn't accepted yet, Supabase just issues a fresh
    // invite link and re-sends the email. If they've already set a
    // password, this call fails (they're a real registered user now), so we
    // turn that into a clearer message pointing at "Forgot password" instead.
    const { error: authError } = await supabaseAdmin.auth.admin.inviteUserByEmail(email, {
      data: { full_name, role },
    });

    if (authError) {
      const alreadyRegistered = /already.*registered|already.*exists/i.test(authError.message);
      return NextResponse.json(
        {
          error: alreadyRegistered
            ? "This person has already accepted their invite and set a password. They should use \"Forgot password\" on the login screen instead."
            : authError.message,
        },
        { status: 400 }
      );
    }

    return NextResponse.json({ success: true });
  } catch (err: any) {
    return NextResponse.json({ error: err.message ?? "Failed to resend invite" }, { status: 500 });
  }
}
