import { NextRequest, NextResponse } from "next/server";
import { requireOfficeOrAdmin } from "@/lib/api/guards";
import { callerClient } from "@/lib/api/caller-client";
import { renderDocumentPdf } from "@/lib/pdf/render";
import { businessInfo } from "@/lib/business-info";
import { getResend, getFromAddress } from "@/lib/resend";
import { formatDate } from "@/lib/date";
import { escapeHtml } from "@/lib/html";

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const body = await request.json().catch(() => ({}));

    // Office/admin-only; Bearer (mobile) or cookie (web) via a caller-scoped client.
    const guard = await requireOfficeOrAdmin(request);
    if (!guard.ok) return guard.response;
    const supabase = await callerClient(request);

    const { data: quote } = await supabase
      .from("quotes")
      .select("*, customers(name, email, phone), quote_items(*)")
      .eq("id", id)
      .single();

    if (!quote) return NextResponse.json({ error: "Quote not found" }, { status: 404 });

    const to = body.to || quote.customers?.email;
    if (!to) {
      return NextResponse.json(
        { error: "This customer has no email address on file. Add one or enter an email to send to." },
        { status: 400 }
      );
    }
    if (!quote.quote_items || quote.quote_items.length === 0) {
      return NextResponse.json({ error: "Quote has no line items — add items before sending" }, { status: 400 });
    }

    const buffer = await renderDocumentPdf({
      docType: "Quote",
      docNumber: quote.quote_number,
      customer: quote.customers,
      items: quote.quote_items,
      subtotal: Number(quote.subtotal),
      taxAmount: Number(quote.tax_amount),
      total: Number(quote.total),
      createdAt: quote.created_at,
      dateLabel: "Valid Until",
      dateValue: quote.valid_until,
      notes: quote.notes,
      business: businessInfo,
    });

    const resend = getResend();
    // ESCAPE FIRST, then convert newlines — the other order would escape the
    // <br/> tags this line just inserted. body.message is typed by a user and
    // lands in an email sent to a customer.
    const personalNote = body.message
      ? `<p>${escapeHtml(String(body.message)).replace(/\n/g, "<br/>")}</p>`
      : "";
    const validUntilLine = quote.valid_until
      ? `<p>This quote is valid until <strong>${formatDate(quote.valid_until)}</strong>.</p>`
      : "";

    const { error: sendError } = await resend.emails.send({
      from: getFromAddress(),
      to,
      subject: `Quote #${quote.quote_number} from ${businessInfo.name}`,
      html: `
        <div style="font-family: sans-serif; color: #1e293b; line-height: 1.5;">
          <p>Hi ${escapeHtml(quote.customers?.name ?? "there")},</p>
          <p>Please find attached your quote <strong>#${quote.quote_number} — ${escapeHtml(quote.title)}</strong> for <strong>$${Number(quote.total).toFixed(2)}</strong> (inc. GST).</p>
          ${personalNote}
          ${validUntilLine}
          <p>If you have any questions, just reply to this email.</p>
          <p>Thanks,<br/>${businessInfo.name}</p>
        </div>
      `,
      attachments: [
        {
          filename: `quote-${quote.quote_number}.pdf`,
          content: buffer.toString("base64"),
        },
      ],
    });

    if (sendError) throw new Error(sendError.message);

    // The email is already gone. This write only records that, and it used to
    // be discarded — so a refused update left the quote showing "draft", and
    // the obvious next action is to send it again. The customer gets it twice.
    const { error: statusError } = await supabase.from("quotes").update({ status: "sent" }).eq("id", id);

    if (statusError) {
      console.error("quote send: email delivered but status not updated:", statusError.message);
      return NextResponse.json({
        success: true,
        sentTo: to,
        statusUpdated: false,
        warning:
          `The quote WAS emailed to ${to}, but its status could not be updated ` +
          `(${statusError.message}). It will still show as draft — do NOT send it again.`,
      });
    }

    return NextResponse.json({ success: true, sentTo: to });
  } catch (err: any) {
    console.error("Send quote error:", err);
    return NextResponse.json({ error: err.message ?? "Failed to send quote" }, { status: 500 });
  }
}
