import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { renderDocumentPdf } from "@/lib/pdf/render";
import { businessInfo } from "@/lib/business-info";
import { getResend, getFromAddress } from "@/lib/resend";
import { formatDate } from "@/lib/date";

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const body = await request.json().catch(() => ({}));
    const supabase = await createClient();

    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

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
    const personalNote = body.message ? `<p>${String(body.message).replace(/\n/g, "<br/>")}</p>` : "";
    const validUntilLine = quote.valid_until
      ? `<p>This quote is valid until <strong>${formatDate(quote.valid_until)}</strong>.</p>`
      : "";

    const { error: sendError } = await resend.emails.send({
      from: getFromAddress(),
      to,
      subject: `Quote #${quote.quote_number} from ${businessInfo.name}`,
      html: `
        <div style="font-family: sans-serif; color: #1e293b; line-height: 1.5;">
          <p>Hi ${quote.customers?.name ?? "there"},</p>
          <p>Please find attached your quote <strong>#${quote.quote_number} — ${quote.title}</strong> for <strong>$${Number(quote.total).toFixed(2)}</strong> (inc. GST).</p>
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

    await supabase.from("quotes").update({ status: "sent" }).eq("id", id);

    return NextResponse.json({ success: true, sentTo: to });
  } catch (err: any) {
    console.error("Send quote error:", err);
    return NextResponse.json({ error: err.message ?? "Failed to send quote" }, { status: 500 });
  }
}
