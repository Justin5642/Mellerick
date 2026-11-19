import { NextRequest, NextResponse } from "next/server";
import { requireOfficeOrAdmin } from "@/lib/api/guards";
import { callerClient } from "@/lib/api/caller-client";
import { reportError } from "@/lib/monitoring";
import {
  decodeUploadedFile,
  isUuidLike,
  loadJobPurchaseOrders,
  parseMoney,
  safeFileName,
  supplierInvoicePath,
} from "@/lib/job-purchase-orders";

// "+ Enter supplier invoice" on a supplier order, from the phone (Stage 4's
// web form, 0089): invoice number, date, amount ex GST (GST at 10%) and,
// optionally, a photo or PDF of the invoice. That is what puts the cost on the
// job's ledger and what "Send to Xero" (/api/xero/push-vendor-order) makes the
// bill from. Office/admin, as the caller.
//
// The file goes to job-documents at the web's own path,
// `{job}/expense-receipt-{PO}-{ts}_{name}` — the `expense-receipt-` segment is
// what 0047's money-file rule keys on, so technicians can't open it. Uploaded
// BEFORE the row changes; a failed row write removes it again. Once the order
// is a Xero bill the amount is locked, as on the web.

type Ctx = { params: Promise<{ id: string; orderId: string }> };

const NOT_FOUND = "That supplier order isn't on this job any more. Refresh to see it.";
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export const maxDuration = 30;

export async function POST(request: NextRequest, { params }: Ctx) {
  const guard = await requireOfficeOrAdmin(request);
  if (!guard.ok) return guard.response;
  const { id: jobId, orderId } = await params;
  if (!isUuidLike(jobId) || !isUuidLike(orderId)) return NextResponse.json({ error: NOT_FOUND }, { status: 404 });

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const number = typeof body?.invoiceNumber === "string" ? body.invoiceNumber.trim().slice(0, 100) : "";
  const amount = parseMoney(body?.amount);
  const date = typeof body?.invoiceDate === "string" && DATE.test(body.invoiceDate) ? body.invoiceDate : null;
  if (!number) return NextResponse.json({ error: "Enter the supplier's invoice number." }, { status: 400 });
  if (amount === null || amount <= 0) return NextResponse.json({ error: "Enter the invoice amount ex GST." }, { status: 400 });
  const file = body?.file != null ? decodeUploadedFile(body.file) : null;
  if (file && !file.ok) return NextResponse.json({ error: file.error }, { status: 400 });

  try {
    const supabase = await callerClient(request);
    const { data: order, error: readError } = await supabase
      .from("vendor_orders")
      .select("id, po_number, status, amount, xero_bill_id, invoice_storage_path")
      .eq("id", orderId)
      .eq("job_id", jobId)
      .maybeSingle();
    if (readError) throw readError;
    if (!order) return NextResponse.json({ error: NOT_FOUND }, { status: 404 });
    if (order.xero_bill_id && amount !== Number(order.amount)) {
      return NextResponse.json({ error: "Already sent to Xero as a bill — change the amount in Xero." }, { status: 409 });
    }

    let path: string | null = order.invoice_storage_path ?? null;
    let uploaded: string | null = null;
    if (file && file.ok) {
      uploaded = supplierInvoicePath(jobId, order.po_number, safeFileName(body?.fileName, file.ext));
      const { error: upError } = await supabase.storage.from("job-documents").upload(uploaded, file.bytes, { contentType: file.contentType });
      if (upError) {
        console.error("supplier invoice upload failed:", upError);
        return NextResponse.json({ error: "Couldn't upload the invoice file. Try again." }, { status: 502 });
      }
      path = uploaded;
    }

    const patch = {
      invoice_number: number,
      invoice_date: date,
      amount,
      gst_amount: Math.round(amount * 10) / 100,
      invoice_storage_path: path,
      status: order.status === "cancelled" ? order.status : "received",
    };
    const { error, count } = await supabase.from("vendor_orders").update(patch, { count: "exact" }).eq("id", orderId).eq("job_id", jobId);
    if (error || count === 0) {
      if (uploaded) await supabase.storage.from("job-documents").remove([uploaded]).catch(() => {});
      if (error) throw error;
      return NextResponse.json({ error: "Couldn't save the invoice." }, { status: 409 });
    }
    return NextResponse.json(await loadJobPurchaseOrders(supabase, jobId));
  } catch (err) {
    console.error("supplier invoice POST error:", err);
    reportError(err, { route: "api/jobs/supplier-orders/[orderId]/invoice" });
    return NextResponse.json({ error: "Couldn't save the invoice. Try again." }, { status: 500 });
  }
}
