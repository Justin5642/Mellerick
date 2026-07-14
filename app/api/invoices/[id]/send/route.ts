import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { renderDocumentPdf } from "@/lib/pdf/render";
import { businessInfo } from "@/lib/business-info";
import { getResend, getFromAddress } from "@/lib/resend";
import { formatDate } from "@/lib/date";
import { formatInvoiceNumber } from "@/lib/utils";

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const body = await request.json().catch(() => ({}));
    const supabase = await createClient();

    const { data: invoice } = await supabase
      .from("invoices")
      .select("*, customers(name, email, phone), invoice_items(*)")
      .eq("id", id)
      .single();

    if (!invoice) return NextResponse.json({ error: "Invoice not found" }, { status: 404 });

    const to = body.to || invoice.customers?.email;
    if (!to) {
      return NextResponse.json(
        { error: "This customer has no email address on file. Add one or enter an email to send to." },
        { status: 400 }
      );
    }
    if (!invoice.invoice_items || invoice.invoice_items.length === 0) {
      return NextResponse.json({ error: "Invoice has no line items — add items before sending" }, { status: 400 });
    }

    const buffer = await renderDocumentPdf({
      docType: "Tax Invoice",
      docNumber: invoice.invoice_number,
      customer: invoice.customers,
      items: invoice.invoice_items,
      subtotal: Number(invoice.subtotal),
      taxAmount: Number(invoice.tax_amount),
      total: Number(invoice.total),
      createdAt: invoice.created_at,
      dateLabel: "Due Date",
      dateValue: invoice.due_date,
      notes: invoice.notes,
      business: businessInfo,
    });

    const resend = getResend();
    const personalNote = body.message ? `<p>${String(body.message).replace(/\n/g, "<br/>")}</p>` : "";
    const dueDateLine = invoice.due_date
      ? `<p>Payment is due by <strong>${formatDate(invoice.due_date, { day: "numeric", month: "short", year: "numeric" })}</strong>.</p>`
      : "";

    const { error: sendError } = await resend.emails.send({
      from: getFromAddress(),
      to,
      subject: `Invoice ${formatInvoiceNumber(invoice.invoice_number)} from ${businessInfo.name}`,
      html: `
        <div style="font-family: sans-serif; color: #1e293b; line-height: 1.5;">
          <p>Hi ${invoice.customers?.name ?? "there"},</p>
          <p>Please find attached your invoice <strong>${formatInvoiceNumber(invoice.invoice_number)} — ${invoice.title}</strong> for <strong>$${Number(invoice.total).toFixed(2)}</strong> (inc. GST).</p>
          ${personalNote}
          ${dueDateLine}
          <p>If you have any questions, just reply to this email.</p>
          <p>Thanks,<br/>${businessInfo.name}</p>
        </div>
      `,
      attachments: [
        {
          filename: `invoice-${invoice.invoice_number}.pdf`,
          content: buffer.toString("base64"),
        },
      ],
    });

    if (sendError) throw new Error(sendError.message);

    await supabase.from("invoices").update({ status: "sent" }).eq("id", id);

    return NextResponse.json({ success: true, sentTo: to });
  } catch (err: any) {
    console.error("Send invoice error:", err);
    return NextResponse.json({ error: err.message ?? "Failed to send invoice" }, { status: 500 });
  }
}
