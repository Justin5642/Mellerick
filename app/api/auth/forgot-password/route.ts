import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

// Sends the password-reset email from the SERVER, with an implicit-flow client.
//
// /forgot-password used to call resetPasswordForEmail from the browser client,
// which @supabase/ssr makes PKCE: the emailed link then only works in the very
// browser that asked for it (it needs that browser's code-verifier cookie). A
// technician who asks on their phone and opens the email in the Gmail app, or
// on another device, got "invalid or expired" every time. An implicit link
// carries its own tokens, which /update-password applies with setSession, so
// it works wherever it is opened — the same shape the mobile app's "Forgot
// password?" and every staff invite already produce.
//
// No service-role key: this is the public anon client doing exactly what the
// browser did, just with a different flow type. Supabase's own per-email rate
// limit still applies, and its answer never reveals whether an account exists.
export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  const email = typeof body.email === "string" ? body.email.trim() : "";
  if (!email) return NextResponse.json({ error: "Email is required." }, { status: 400 });

  const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    auth: { flowType: "implicit", persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const { error } = await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: `${new URL(request.url).origin}/update-password`,
  });
  if (error) {
    return NextResponse.json({ error: error.message }, { status: error.status === 429 ? 429 : 400 });
  }
  return NextResponse.json({ ok: true });
}
