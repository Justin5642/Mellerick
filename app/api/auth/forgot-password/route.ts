import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { appUrl } from "@/lib/env";

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
    // Fixed origin, not the request's — see appUrl() in lib/env.ts.
    redirectTo: `${appUrl()}/update-password`,
  });
  if (error) {
    // Supabase's text stays in the log. Only the rate limit is worth telling
    // the person about, and it says nothing about whether the account exists.
    console.error("Password reset email failed:", error.status, error.message);
    if (error.status === 429) {
      return NextResponse.json({ error: "Too many reset requests. Wait a few minutes and try again." }, { status: 429 });
    }
    return NextResponse.json({ error: "Could not send the reset email. Try again shortly." }, { status: 400 });
  }
  return NextResponse.json({ ok: true });
}
