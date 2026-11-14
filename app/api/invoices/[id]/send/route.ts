import { NextRequest, NextResponse } from "next/server";
import { requireOfficeOrAdmin } from "@/lib/api/guards";
import { callerClient } from "@/lib/api/caller-client";
import { renderDocumentPdf } from "@/lib/pdf/render";
import { businessInfo } from "@/lib/business-info";
import { INVOICE_SITE_SELECT, invoiceJobSite } from "@/lib/job-site";
import { invoiceProgress } from "@/lib/progress-claim";
import { customerPoLabel } from "@/lib/customer-po";
import { getResend, getFromAddress } from "@/lib/resend";
import { formatDate } from "@/lib/date";
import { formatInvoiceNumber } from "@/lib/utils";
import { escapeHtml } from "@/lib/html";
import { reportError } from "@/lib/monitoring";
import { parseJobReportRequest } from "@/lib/job-report";
import { buildJobReportPdf, loadJobReportContext } from "@/lib/job-report-data";

// A user is waiting on this request while it calls an outside service (Xero,
// Google, the email provider, or the PDF renderer). Without a cap a hung
// upstream held the spinner for minutes; 30s did that until the optional job
// report (up to 40 photos downloaded and downscaled) needed more room.
export const maxDuration = 60;

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const body = await request.json().catch(() => ({}));

    // Sending an invoice is office/admin-only. Authorize the caller (Bearer token
    // from mobile OR web session cookie), then use a caller-scoped client so the
    // RLS-protected reads/writes below work for both surfaces.
    const guard = await requireOfficeOrAdmin(request);
    if (!guard.ok) return guard.response;
    const supabase = await callerClient(request);

    const { data: invoice } = await supabase
      .from("invoices")
      .select(`*, customers(name, email, phone), invoice_items(*), ${INVOICE_SITE_SELECT}`)
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
      // The emailed copy left this out while the downloaded PDF had it.
      workDescription: invoice.work_description,
      jobSite: invoiceJobSite(invoice),
      poNumber: invoice.customer_po,
      amountPaid: Number(invoice.amount_paid ?? 0),
      progress: invoiceProgress(invoice),
      business: businessInfo,
    });

    // Optional customer job report (Send Invoice dialog). Callers that don't
    // send `jobReport` — the phone's invoice send — get exactly the old email.
    // If it was asked for and can't be made, NOTHING is sent: the office
    // retries or unticks it, rather than the customer silently getting the
    // invoice alone.
    let jobReport: { buffer: Buffer; notice: string | null } | null = null;
    if (body.jobReport != null) {
      const parsed = parseJobReportRequest(body.jobReport);
      if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
      if (!invoice.job_id) {
        return NextResponse.json(
          { error: "This invoice is not linked to a job, so there is no job report to attach." },
          { status: 400 }
        );
      }
      try {
        const loaded = await loadJobReportContext(supabase, id);
        if (!loaded.ok) return NextResponse.json({ error: `${loaded.error} Nothing was sent.` }, { status: loaded.status });
        jobReport = await buildJobReportPdf(supabase, loaded.context, parsed.value);
      } catch (reportErr) {
        console.error("invoice send: job report failed:", reportErr);
        reportError(reportErr, { route: "api/invoices/send", integration: "react-pdf", operation: "job-report" });
        return NextResponse.json(
          {
            error:
              "The job report could not be made, so the invoice was NOT sent. " +
              "Try again, or untick \"Include job report and photos\" to send the invoice on its own.",
          },
          { status: 500 }
        );
      }
    }

    const po = customerPoLabel(invoice.customer_po);
    const resend = getResend();
    // ESCAPE FIRST, then convert newlines — the other order would escape the
    // <br/> tags this line just inserted. body.message is typed by a user and
    // lands in an email sent to a customer.
    const personalNote = body.message
      ? `<p>${escapeHtml(String(body.message)).replace(/\n/g, "<br/>")}</p>`
      : "";
    const dueDateLine = invoice.due_date
      ? `<p>Payment is due by <strong>${formatDate(invoice.due_date, { day: "numeric", month: "short", year: "numeric" })}</strong>.</p>`
      : "";

    const { error: sendError } = await resend.emails.send({
      from: getFromAddress(),
      to,
      // The PO in the subject: accounts inboxes file and approve by it (0083).
      subject: `Invoice ${formatInvoiceNumber(invoice.invoice_number)}${po ? ` (${po})` : ""} from ${businessInfo.name}`,
      html: `
        <div style="font-family: sans-serif; color: #1e293b; line-height: 1.5;">
          <p>Hi ${escapeHtml(invoice.customers?.name ?? "there")},</p>
          <p>Please find attached your invoice <strong>${formatInvoiceNumber(invoice.invoice_number)} — ${escapeHtml(invoice.title)}</strong> for <strong>$${Number(invoice.total).toFixed(2)}</strong> (inc. GST).</p>
          ${po ? `<p>Your purchase order: <strong>${escapeHtml(invoice.customer_po)}</strong></p>` : ""}
          ${personalNote}
          ${dueDateLine}
          ${jobReport ? "<p>We've also attached a job report with the dates we attended, notes on the work carried out and photos of the job.</p>" : ""}
          <p>If you have any questions, just reply to this email.</p>
          <p>Thanks,<br/>${businessInfo.name}</p>
        </div>
      `,
      attachments: [
        {
          filename: `invoice-${invoice.invoice_number}.pdf`,
          content: buffer.toString("base64"),
        },
        ...(jobReport
          ? [{ filename: `job-report-${invoice.invoice_number}.pdf`, content: jobReport.buffer.toString("base64") }]
          : []),
      ],
    });

    if (sendError) throw new Error(sendError.message);

    // The email is already gone. This write only records that, and it used to
    // be discarded — so a refused update left the invoice showing "draft", and
    // the obvious next action is to send it again. The customer gets it twice.
    const { error: statusError } = await supabase.from("invoices").update({ status: "sent" }).eq("id", id);

    if (statusError) {
      console.error("invoice send: email delivered but status not updated:", statusError.message);
      return NextResponse.json({
        success: true,
        sentTo: to,
        statusUpdated: false,
        warning:
          `The invoice WAS emailed to ${to}, but its status could not be updated ` +
          `(${statusError.message}). It will still show as draft — do NOT send it again.`,
        reportNotice: jobReport?.notice ?? null,
      });
    }

    return NextResponse.json({
      success: true,
      sentTo: to,
      jobReportAttached: !!jobReport,
      reportNotice: jobReport?.notice ?? null,
    });
  } catch (err: any) {
    console.error("Send invoice error:", err);
    reportError(err, { route: "api/invoices/send", integration: "resend" });
    return NextResponse.json({ error: err.message ?? "Failed to send invoice" }, { status: 500 });
  }
}
