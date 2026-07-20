import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireUser } from "@/lib/api/guards";

// Redirects to a short-lived signed URL for the generated report PDF —
// same idea as job-documents' download button, just via a GET route so it
// can be linked directly (target="_blank") from the device detail page.
//
// Also callable from the mobile app (no cookies) via a Bearer access token —
// same dual-auth pattern as the submit route. Mobile passes ?json=1 since it
// wants the signed URL back as data (to hand to Linking.openURL) rather than
// following a redirect. Any authenticated staff member may view a certificate
// (office needs to see tests they didn't perform); the signed URL is short-lived.
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const guard = await requireUser(request);
  if (!guard.ok) return guard.response;

  const supabase = createAdminClient();

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
