import { NextRequest, NextResponse } from "next/server";
import { requireOfficeOrAdmin } from "@/lib/api/guards";
import { callerClient } from "@/lib/api/caller-client";
import { reportError } from "@/lib/monitoring";
import { fileOnOrder, JOB_COLUMNS, ORDER_COLUMNS } from "@/lib/gmail-invoices";
import {
  creditDocumentPath,
  expenseDocumentPath,
  jobTakesBill,
  orderRefusal,
  typedPoNumber,
  type CandidateJob,
  type CandidateOrder,
  type CheckedFields,
} from "@/lib/gmail-invoice-rules";
import { CREDIT_COLUMNS, CREDIT_SENTENCES, creditRefusal, isCreditsTableMissing, type VendorOrderCredit } from "@/lib/vendor-order-credits";

// The office's decision on one emailed supplier invoice (0124, drafted) in the review
// queue on Supplier POs:
//   { action: "assign", poNumber } — put it on that supplier PO (file copied
//       to the job, invoice fields filled, flagged "from email — check" like
//       an automatic match; never sent to Xero from here);
//   { action: "dismiss" } — not an invoice we need (or entered by hand);
//   { action: "reopen" }  — back into the queue (also a statement the import
//       put away by itself);
//   { action: "credit" }  — a credit note: add it under its PO as a
//       vendor_order_credits row (0125) — never touching the PO's own
//       invoice — with the file copied to the job. Not sent to Xero;
//   { action: "expense" } — a bill quoting only a job number: add it to that
//       job as a job_expenses row (the Expenses tab's shape), file copied to
//       the job. Its id is the emailed row's id, so a retry adds nothing.
// Both one-click actions are only offered (lib/gmail-invoice-rules.ts
// reviewOffer) and everything is checked again here.
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
  if (action !== "assign" && action !== "dismiss" && action !== "reopen" && action !== "credit" && action !== "expense") {
    return fail("Choose what to do with it.", 400);
  }

  const db = await callerClient(request);
  const got = await db.from("gmail_supplier_invoices").select("*").eq("id", id).maybeSingle();
  if (got.error) {
    reportError(got.error, { route: ROUTE, step: "load" });
    return fail("Could not load the invoice.", 500);
  }
  const row = got.data as EmailedRow | null;
  if (!row) return fail("That invoice no longer exists.", 404);

  const stamp = { handled_by: guard.userId, handled_at: new Date().toISOString(), updated_at: new Date().toISOString() };

  if (action === "credit") return applyCredit(db, row, stamp);
  if (action === "expense") return addExpense(db, row, stamp, guard.userId);

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

type EmailedRow = CheckedFields & {
  id: string;
  status: string;
  storage_path: string | null;
  file_name: string | null;
  mime_type: string | null;
  vendor_order_id: string | null;
  job_id: string | null;
};
type Db = Awaited<ReturnType<typeof callerClient>>;
type Stamp = { handled_by: string; handled_at: string; updated_at: string };

const money2 = (n: unknown) => Math.round((Number(n) || 0) * 100) / 100;

/** Claim the row (needs_review → matched) so two clicks can't file it twice. Answers a response on failure. */
async function claimRow(db: Db, id: string, patch: Record<string, unknown>, step: string): Promise<NextResponse | null> {
  const claim = await db.from("gmail_supplier_invoices").update({ status: "matched", review_reason: null, ...patch }).eq("id", id).eq("status", "needs_review").select("id");
  if (claim.error) {
    reportError(claim.error, { route: ROUTE, step });
    return fail("Could not update the invoice.", 500);
  }
  if (!claim.data?.length) return fail("Someone else just changed this invoice. Reload and try again.", 409);
  return null;
}

async function putBack(db: Db, id: string, patch: Record<string, unknown>) {
  const back = await db.from("gmail_supplier_invoices").update({ status: "needs_review", ...patch }).eq("id", id);
  if (back.error) reportError(back.error, { route: ROUTE, step: "undo" });
}

async function downloadOriginal(db: Db, path: string): Promise<Buffer | null> {
  const file = await db.storage.from("supplier-invoices").download(path);
  if (file.error || !file.data) {
    reportError(file.error, { route: ROUTE, step: "download" });
    return null;
  }
  return Buffer.from(await file.data.arrayBuffer());
}

/** "Apply credit to PO": a credit note under its PO (0125). Never the PO's own invoice; never Xero. */
async function applyCredit(db: Db, row: EmailedRow, stamp: Stamp): Promise<NextResponse> {
  if (row.doc_kind !== "credit_note") return fail("This isn't a credit note.", 400);

  // A second click after it went through: answered as done, nothing added.
  if (row.status === "matched") {
    const done = await db.from("vendor_order_credits").select("id").eq("gmail_invoice_id", row.id).maybeSingle();
    if (done.error && !isCreditsTableMissing(done.error)) reportError(done.error, { route: ROUTE, step: "credit retry" });
    if (done.data) return NextResponse.json({ ok: true, status: "matched", already: true });
    return fail("This credit note was already dealt with.", 409);
  }
  if (row.status !== "needs_review") return fail("Only a credit note waiting for review can be applied.", 409);
  if (!row.vendor_order_id) return fail("No PO was found for this credit note — enter it by hand.", 400);
  if (!row.invoice_number) return fail("No credit note number was read — enter this one by hand.", 400);
  const amount = money2(row.amount_ex_gst);
  if (!(amount > 0)) return fail("No amount was read — enter this one by hand.", 400);
  if (!row.storage_path) return fail("The file wasn't saved — enter this one by hand.", 400);
  const gst = row.gst_amount === null ? money2(amount * 0.1) : money2(row.gst_amount);

  const po = await db.from("vendor_orders").select(ORDER_COLUMNS).eq("id", row.vendor_order_id).maybeSingle();
  if (po.error) {
    reportError(po.error, { route: ROUTE, step: "credit po" });
    return fail("Could not look up the PO.", 500);
  }
  const order = po.data as (CandidateOrder & { amount: number | string | null }) | null;
  if (!order) return fail("That supplier PO no longer exists.", 404);

  const existing = await db.from("vendor_order_credits").select(CREDIT_COLUMNS).eq("vendor_order_id", order.id);
  if (existing.error) {
    if (isCreditsTableMissing(existing.error)) return fail(CREDIT_SENTENCES.notSwitchedOn, 409);
    reportError(existing.error, { route: ROUTE, step: "credits" });
    return fail("Could not read the PO's credits.", 500);
  }
  const refused = creditRefusal(order, (existing.data ?? []) as VendorOrderCredit[], { amount_ex_gst: amount, credit_number: row.invoice_number });
  if (refused) return fail(refused, 409);

  const claimed = await claimRow(db, row.id, { vendor_order_id: order.id, job_id: order.job_id, ...stamp }, "credit claim");
  if (claimed) return claimed;

  const bytes = await downloadOriginal(db, row.storage_path);
  if (!bytes) {
    await putBack(db, row.id, {});
    return fail("The file could not be found.", 500);
  }
  const path = creditDocumentPath(order.job_id, order.po_number, row.file_name ?? "credit-note", Date.now());
  const up = await db.storage.from("job-documents").upload(path, bytes, { contentType: row.mime_type ?? "application/pdf" });
  if (up.error) {
    reportError(up.error, { route: ROUTE, step: "credit file" });
    await putBack(db, row.id, {});
    return fail(`The file couldn't be attached to ${order.po_number}'s job.`, 500);
  }
  const ins = await db.from("vendor_order_credits").insert({
    id: row.id,
    vendor_order_id: order.id,
    gmail_invoice_id: row.id,
    credit_number: row.invoice_number,
    credit_date: row.invoice_date,
    amount_ex_gst: amount,
    gst_amount: gst,
    file_path: path,
  });
  if (ins.error) {
    await db.storage.from("job-documents").remove([path]);
    await putBack(db, row.id, {});
    if (isCreditsTableMissing(ins.error)) return fail(CREDIT_SENTENCES.notSwitchedOn, 409);
    if (ins.error.code === "23514" || ins.error.code === "23505") {
      return fail(`${order.po_number} changed just now — the credit no longer fits. Reload and check it.`, 409);
    }
    reportError(ins.error, { route: ROUTE, step: "credit insert" });
    return fail("Could not save the credit.", 500);
  }
  const link = await db.from("gmail_supplier_invoices").update({ job_document_path: path }).eq("id", row.id);
  if (link.error) reportError(link.error, { route: ROUTE, step: "link credit file" });
  return NextResponse.json({ ok: true, status: "matched", poNumber: order.po_number, jobId: order.job_id });
}

/** "Add as job expense": a bill quoting only a job number, added to that job's expenses as the caller. */
async function addExpense(db: Db, row: EmailedRow, stamp: Stamp, userId: string): Promise<NextResponse> {
  if (row.doc_kind !== "invoice") return fail("Only an invoice can be added as a job expense.", 400);

  if (row.status === "matched") {
    const done = await db.from("job_expenses").select("id").eq("id", row.id).maybeSingle();
    if (done.error) reportError(done.error, { route: ROUTE, step: "expense retry" });
    if (done.data) return NextResponse.json({ ok: true, status: "matched", already: true });
    return fail("This invoice was already dealt with.", 409);
  }
  if (row.status !== "needs_review") return fail("Only an invoice waiting for review can be added.", 409);
  if (!row.job_id || row.vendor_order_id) return fail("No job was found for this invoice — put it on a PO instead.", 400);
  const amount = money2(row.amount_ex_gst);
  if (!(amount > 0)) return fail("No amount was read — enter this one on the job by hand.", 400);
  if (!row.storage_path) return fail("The file wasn't saved — enter this one on the job by hand.", 400);
  const gst = row.gst_amount === null ? money2(amount * 0.1) : money2(row.gst_amount);

  const got = await db.from("jobs").select(JOB_COLUMNS).eq("id", row.job_id).maybeSingle();
  if (got.error) {
    reportError(got.error, { route: ROUTE, step: "expense job" });
    return fail("Could not look up the job.", 500);
  }
  const job = got.data as CandidateJob | null;
  if (!job) return fail("That job no longer exists.", 404);
  if (!jobTakesBill(job, new Date())) return fail(`Job #${job.job_number} is ${job.status} — enter this one by hand.`, 409);

  if (row.invoice_number) {
    const dup = await db.from("job_expenses").select("id, supplier_name").eq("job_id", job.id).ilike("invoice_number", row.invoice_number);
    if (dup.error) reportError(dup.error, { route: ROUTE, step: "expense duplicate" });
    if ((dup.data ?? []).length > 0) return fail(`Invoice ${row.invoice_number} is already an expense on job #${job.job_number}.`, 409);
  }

  const claimed = await claimRow(db, row.id, { job_id: job.id, vendor_order_id: null, ...stamp }, "expense claim");
  if (claimed) return claimed;

  const bytes = await downloadOriginal(db, row.storage_path);
  if (!bytes) {
    await putBack(db, row.id, {});
    return fail("The file could not be found.", 500);
  }
  const path = expenseDocumentPath(job.id, row.file_name ?? "invoice", Date.now());
  const up = await db.storage.from("job-documents").upload(path, bytes, { contentType: row.mime_type ?? "application/pdf" });
  if (up.error) {
    reportError(up.error, { route: ROUTE, step: "expense file" });
    await putBack(db, row.id, {});
    return fail(`The file couldn't be attached to job #${job.job_number}.`, 500);
  }
  const ins = await db.from("job_expenses").insert({
    id: row.id,
    job_id: job.id,
    supplier_name: (row.supplier_name ?? "Supplier").slice(0, 200),
    category: "materials",
    description: "From an emailed supplier invoice",
    invoice_number: row.invoice_number,
    invoice_date: row.invoice_date,
    amount,
    gst_amount: gst,
    receipt_storage_path: path,
    entered_by: userId,
  });
  if (ins.error) {
    await db.storage.from("job-documents").remove([path]);
    if (ins.error.code === "23505") {
      // Already added (a retry whose first answer was lost): keep it matched.
      return NextResponse.json({ ok: true, status: "matched", already: true });
    }
    await putBack(db, row.id, {});
    reportError(ins.error, { route: ROUTE, step: "expense insert" });
    return fail("Could not add the expense to the job.", 500);
  }
  const link = await db.from("gmail_supplier_invoices").update({ job_document_path: path }).eq("id", row.id);
  if (link.error) reportError(link.error, { route: ROUTE, step: "link expense file" });
  return NextResponse.json({ ok: true, status: "matched", jobNumber: job.job_number, jobId: job.id });
}
