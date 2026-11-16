import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/api/guards";
import { getResend, getFromAddress, getReplyTo } from "@/lib/resend";
import { businessInfo } from "@/lib/business-info";
import { renderDocumentPdf } from "@/lib/pdf/render";
import { escapeHtml } from "@/lib/html";
import { reportError } from "@/lib/monitoring";

// Admin-only: sends a sample invoice email exactly as a real one goes out —
// same From, Reply-To and PDF attachment — so delivery, the sender shown and
// replies can be checked after a domain change (Settings → Email). Sample
// figures only; no customer data.
export async function POST(request: NextRequest) {
  const guard = await requireAdmin(request);
  if (!guard.ok) return guard.response;
  const body = await request.json().catch(() => ({}));
  const to = typeof body?.to === "string" ? body.to.trim() : "";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
    return NextResponse.json({ error: "Enter the email address to send the test to." }, { status: 400 });
  }

  const from = getFromAddress();
  const replyTo = getReplyTo();
  try {
    const pdf = await renderDocumentPdf({
      docType: "Tax Invoice",
      docNumber: "TEST",
      customer: { name: "Test customer", email: to },
      items: [{ name: "Test line — please ignore", description: null, quantity: 1, unit_price: 100, total: 100 } as never],
      subtotal: 100,
      taxAmount: 10,
      total: 110,
      createdAt: new Date().toISOString(),
      dateLabel: "Due Date",
      dateValue: null,
      notes: "This is a test invoice from the Mellerick app. No payment is due.",
      business: businessInfo,
    } as never);
    const { error } = await getResend().emails.send({
      from,
      to,
      replyTo,
      subject: `TEST — Invoice from ${businessInfo.name}`,
      html: `
        <div style="font-family: sans-serif; color: #1e293b; line-height: 1.5;">
          <p>This is a <strong>test invoice email</strong> from the Mellerick app. No payment is due.</p>
          <p>Sent from: <strong>${escapeHtml(from)}</strong><br/>Replies go to: <strong>${escapeHtml(replyTo.join(", "))}</strong></p>
          <p>Please hit Reply and send anything back, then check that it arrives in that mailbox.</p>
          <p>Thanks,<br/>${escapeHtml(businessInfo.name)}</p>
        </div>`,
      attachments: [{ filename: "invoice-TEST.pdf", content: pdf.toString("base64") }],
    });
    if (error) {
      console.error("test email failed:", error.message);
      return NextResponse.json(
        { error: `The email service refused the test: ${error.message}`, from, replyTo },
        { status: 502 },
      );
    }
    return NextResponse.json({ success: true, to, from, replyTo });
  } catch (err) {
    console.error("test email failed:", err);
    reportError(err, { route: "api/email/test", integration: "resend" });
    return NextResponse.json({ error: "The test email could not be sent.", from, replyTo }, { status: 500 });
  }
}
