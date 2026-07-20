import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireUser } from "@/lib/api/guards";
import { isOfficeOrAdmin } from "@/lib/api/job-authz";
import { renderBackflowPdf } from "@/lib/pdf/render-backflow";
import { businessInfo } from "@/lib/business-info";
import { getResend, getFromAddress } from "@/lib/resend";
import { getWaterAuthorityEmail, getWaterAuthorityLabel } from "@/lib/backflow";
import { escapeHtml } from "@/lib/html";

// Called from both the dashboard (browser session, cookies) and the mobile
// app (no cookies -- Bearer access token instead, same pattern as
// transcribe-voice-report). Whichever way the caller authenticates, the
// actual PDF render + email send always runs under the service-role key so
// it can read/write regardless of RLS and reach the private storage bucket.
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const guard = await requireUser(request);
  if (!guard.ok) return guard.response;

  const supabase = createAdminClient();

  try {
    const { data: test, error: testError } = await supabase
      .from("backflow_tests")
      .select("*, backflow_devices(*, customers(name), sites(address_line1, address_line2, suburb, state, postcode)), jobs(job_number)")
      .eq("id", id)
      .single();

    if (testError || !test) {
      return NextResponse.json({ error: "Backflow test not found" }, { status: 404 });
    }

    // Authorize per-record before submitting to a water authority: office/admin
    // may submit any test; a technician may submit only one they performed
    // (backflow_tests.tested_by). Prevents acting on another record by id.
    if (!(test.tested_by === guard.userId || (await isOfficeOrAdmin(supabase, guard.userId)))) {
      return NextResponse.json({ error: "Insufficient permissions" }, { status: 403 });
    }

    const device = test.backflow_devices;
    if (!device) {
      return NextResponse.json({ error: "This test has no associated device" }, { status: 400 });
    }

    const to = getWaterAuthorityEmail(device.water_authority);
    if (!to) {
      return NextResponse.json({ error: `No submission email configured for water authority "${device.water_authority}"` }, { status: 400 });
    }

    let signature: { data: Buffer; format: "png" | "jpg" } | null = null;
    if (test.signature_storage_path) {
      const { data: signatureBlob } = await supabase.storage.from("backflow-certificates").download(test.signature_storage_path);
      if (signatureBlob) {
        signature = { data: Buffer.from(await signatureBlob.arrayBuffer()), format: "png" };
      }
    }

    const siteAddress = device.sites
      ? [device.sites.address_line1, device.sites.address_line2, device.sites.suburb, device.sites.state, device.sites.postcode].filter(Boolean).join(", ")
      : null;

    const pdfBuffer = await renderBackflowPdf({
      business: businessInfo,
      waterAuthority: device.water_authority,
      jobNumber: test.jobs?.job_number ?? null,
      customer: { name: device.customers?.name ?? "Unknown customer" },
      siteAddress,
      device,
      test: { ...test, test_results: test.test_results ?? [] },
      signature,
    });

    const certificatePath = `${device.id}/${test.id}_${Date.now()}.pdf`;
    const { error: uploadError } = await supabase.storage.from("backflow-certificates").upload(certificatePath, pdfBuffer, {
      contentType: "application/pdf",
    });
    if (uploadError) {
      return NextResponse.json({ error: `Failed to save certificate: ${uploadError.message}` }, { status: 500 });
    }

    const authorityLabel = getWaterAuthorityLabel(device.water_authority);
    const resend = getResend();
    const { error: sendError } = await resend.emails.send({
      from: getFromAddress(),
      to,
      cc: businessInfo.email,
      subject: `Backflow Prevention Device Test Report — ${device.customers?.name ?? "Customer"}${siteAddress ? ` (${siteAddress})` : ""}`,
      html: `
        <div style="font-family: sans-serif; color: #1e293b; line-height: 1.5;">
          <p>Hi ${escapeHtml(authorityLabel)} team,</p>
          <p>Please find attached the completed backflow prevention device inspection and test report for:</p>
          <p><strong>${escapeHtml(device.customers?.name ?? "Customer")}</strong>${siteAddress ? `<br/>${escapeHtml(siteAddress)}` : ""}</p>
          <p>Test date: <strong>${escapeHtml(test.test_date)}</strong> &middot; Result: <strong>${escapeHtml(String(test.result).toUpperCase())}</strong></p>
          <p>Thanks,<br/>${escapeHtml(businessInfo.name)}</p>
        </div>
      `,
      attachments: [
        {
          filename: `backflow-test-${device.id.slice(0, 8)}-${test.test_date}.pdf`,
          content: pdfBuffer.toString("base64"),
        },
      ],
    });

    if (sendError) throw new Error(sendError.message);

    const { error: updateError } = await supabase
      .from("backflow_tests")
      .update({
        certificate_storage_path: certificatePath,
        submitted_to_water_authority_at: new Date().toISOString(),
        submitted_to_email: to,
      })
      .eq("id", id);

    if (updateError) {
      return NextResponse.json({ error: updateError.message }, { status: 500 });
    }

    return NextResponse.json({ success: true, sentTo: to });
  } catch (err: any) {
    console.error("Submit backflow test error:", err);
    return NextResponse.json({ error: err.message ?? "Failed to submit backflow test" }, { status: 500 });
  }
}
