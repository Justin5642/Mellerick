import { NextRequest, NextResponse } from "next/server";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { createClient as createServerClient } from "@/lib/supabase/server";

// Redirects to a short-lived signed URL for the generated report PDF —
// same idea as job-documents' download button, just via a GET route so it
// can be linked directly (target="_blank") from the device detail page.
//
// Also callable from the mobile app (no cookies) via a Bearer access token —
// same dual-auth pattern as the submit route. Mobile passes ?json=1 since it
// wants the signed URL back as data (to hand to Linking.openURL) rather than
// following a redirect.
async function getAuthenticatedUserId(request: NextRequest): Promise<string | null> {
  const authHeader = request.headers.get("authorization") ?? "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice("Bearer ".length) : null;
  if (token) {
    const anonClient = createServiceClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const { data, error } = await anonClient.auth.getUser(token);
    if (!error && data.user) return data.user.id;
  }
  const cookieClient = await createServerClient();
  const { data } = await cookieClient.auth.getUser();
  return data.user?.id ?? null;
}

function getAdminClient() {
  return createServiceClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const callerId = await getAuthenticatedUserId(request);
  if (!callerId) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const supabase = getAdminClient();

  const { data: test } = await supabase.from("backflow_tests").select("certificate_storage_path").eq("id", id).single();
  if (!test?.certificate_storage_path) {
    return NextResponse.json({ error: "No certificate on file for this test" }, { status: 404 });
  }

  const { data, error } = await supabase.storage.from("backflow-certificates").createSignedUrl(test.certificate_storage_path, 300);
  if (error || !data?.signedUrl) {
    return NextResponse.json({ error: error?.message ?? "Failed to create signed URL" }, { status: 500 });
  }

  const wantsJson = request.nextUrl.searchParams.get("json") === "1";
  if (wantsJson) {
    return NextResponse.json({ signedUrl: data.signedUrl });
  }

  return NextResponse.redirect(data.signedUrl);
}
