import { NextRequest, NextResponse } from "next/server";
import { requireOfficeOrAdmin } from "@/lib/api/guards";
import { callerClient } from "@/lib/api/caller-client";
import { reportError } from "@/lib/monitoring";
import { fileOnOrder, ORDER_COLUMNS } from "@/lib/gmail-invoices";
import { orderRefusal, typedPoNumber, type CandidateOrder, type CheckedFields } from "@/lib/gmail-invoice-rules";

// The office's decision on one emailed supplier invoice (0124, drafted) in the review
// queue on Supplier POs:
//   { action: "assign", poNumber } — put it on that supplier PO (file copied
//       to the job, invoice fields filled, flagged "from email — check" like
//       an automatic match; never sent to Xero from here);
//   { action: "dismiss" } — not an invoice we need (or entered by hand);
//   { action: "reopen" }  — back into the queue.
// Office/admin, and every read and write runs as the CALLER, so RLS (0124, drafted,
// 0061, the storage policies) is the second lock behind the guard. Fixed
// sentences only.

type Ctx = { params: Promise<{ id: string }> };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ROUTE = "api/gmail/invoices";
const fail = (error: string, status: number) => NextResponse.json({ error }, { status });

export const maxDuration = 60;

export async function POST(request: NextRequest, { params }: Ctx) {
  const guard = await requireOfficeOrAdmin(request);
  if (!guard.ok) return guard.response;
  const { id } = await params;
  if (!UUID_RE.test(id)) return fail("Pick an invoice.", 400);

  const body = (await request.json().catch(() => null)) as { action?: unknown; poNumber?: unknown } | null;
  const action = body?.action;
  if (action !== "assign" && action !== "dismiss" && action !== "reopen") return fail("Choose what to do with it.", 400);

  const db = await callerClient(request);
  const got = await db.from("gmail_supplier_invoices").select("*").eq("id", id).maybeSingle();
  if (got.error) {
    reportError(got.error, { route: ROUTE, step: "load" });
    return fail("Could not load the invoice.", 500);
  }
  const row = got.data as (CheckedFields & { id: string; status: string; storage_path: string | null; file_name: string | null; mime_type: string | null }) | null;
  if (!row) return fail("That invoice no longer exists.", 404);

  const stamp = { handled_by: guard.userId, handled_at: new Date().toISOString(), updated_at: new Date().toISOString() };

  if (action === "dismiss" || action === "reopen") {
    const from = action === "dismiss" ? "needs_review" : "dismissed";
    const to = action === "dismiss" ? "dismissed" : "needs_review";
    const upd = await db.from("gmail_supplier_invoices").update({ status: to, ...stamp }).eq("id", id).eq("status", from).select("id");
    if (upd.error) {
      reportError(upd.error, { route: ROUTE, step: action });
      return fail("Could not update the invoice.", 500);
    }
    if (!upd.data?.length) return fail("Someone else just changed this invoice. Reload and try again.", 409);
    return NextResponse.json({ ok: true, status: to });
  }

  // assign
  if (row.status !== "needs_review") return fail("Only an invoice waiting for review can be assigned.", 409);
  const poNumber = typeof body?.poNumber === "string" ? typedPoNumber(body.poNumber.slice(0, 40)) : null;
  if (!poNumber) return fail("Type one of our PO numbers, e.g. PO-1234.", 400);
  if (!row.invoice_number) return fail("No invoice number was read — enter this one on the job's PO tab by hand.", 400);
  if (!(Number(row.amount_ex_gst) > 0)) return fail("No amount was read — enter this one on the job's PO tab by hand.", 400);
  if (!row.storage_path) return fail("The file wasn't saved — enter this one on the job's PO tab by hand.", 400);

  const po = await db.from("vendor_orders").select(ORDER_COLUMNS).ilike("po_number", poNumber).maybeSingle();
  if (po.error) {
    reportError(po.error, { route: ROUTE, step: "po" });
    return fail("Could not look up that PO.", 500);
  }
  const order = po.data as CandidateOrder | null;
  if (!order) return fail(`No supplier PO ${poNumber}.`, 404);
  const refused = orderRefusal(order, row.invoice_number);
  if (refused) return fail(refused, 409);

  // Claim it so two clicks can't file it twice; put back if anything fails.
  const claim = await db
    .from("gmail_supplier_invoices")
    .update({ status: "matched", vendor_order_id: order.id, job_id: order.job_id, review_reason: null, ...stamp })
    .eq("id", id)
    .eq("status", "needs_review")
    .select("id");
  if (claim.error) {
    reportError(claim.error, { route: ROUTE, step: "claim" });
    return fail("Could not assign the invoice.", 500);
  }
  if (!claim.data?.length) return fail("Someone else just changed this invoice. Reload and try again.", 409);
  const undo = async () => {
    const back = await db.from("gmail_supplier_invoices").update({ status: "needs_review", vendor_order_id: null, job_id: null }).eq("id", id);
    if (back.error) reportError(back.error, { route: ROUTE, step: "undo" });
  };

  const file = await db.storage.from("supplier-invoices").download(row.storage_path);
  if (file.error || !file.data) {
    reportError(file.error, { route: ROUTE, step: "download" });
    await undo();
    return fail("The file could not be found.", 500);
  }
  const bytes = Buffer.from(await file.data.arrayBuffer());
  const fields: CheckedFields = {
    doc_kind: row.doc_kind,
    supplier_name: row.supplier_name,
    invoice_number: row.invoice_number,
    invoice_date: row.invoice_date,
    amount_ex_gst: Math.round(Number(row.amount_ex_gst) * 100) / 100,
    gst_amount: row.gst_amount === null ? null : Math.round(Number(row.gst_amount) * 100) / 100,
    total: row.total === null ? null : Number(row.total),
    po_refs: row.po_refs ?? [],
    job_refs: row.job_refs ?? [],
  };
  const filed = await fileOnOrder(db, order, fields, bytes, row.mime_type ?? "application/pdf", row.file_name ?? "invoice", Date.now());
  if (!filed.ok) {
    await undo();
    return fail(filed.reason, 409);
  }
  const link = await db.from("gmail_supplier_invoices").update({ job_document_path: filed.path }).eq("id", id);
  if (link.error) reportError(link.error, { route: ROUTE, step: "link file" });
  return NextResponse.json({ ok: true, status: "matched", poNumber: order.po_number, jobId: order.job_id });
}
