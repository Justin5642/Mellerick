import { NextRequest, NextResponse } from "next/server";
import { requireOfficeOrAdmin } from "@/lib/api/guards";
import { createAdminClient } from "@/lib/supabase/admin";
import { reportError } from "@/lib/monitoring";
import { loadCandidates, toJobCandidate, JOB_COLUMNS, type JobRow } from "@/lib/supplier-invoice-candidates";
import { matchInvoice, parseTarget, type JobCandidate, type PoCandidate } from "@/lib/supplier-invoice-match";

// Cost one supplier invoice (0103) to the job it belongs to.
//
// - On one of our supplier POs: fills that PO's invoice number, date, amount,
//   GST and file and marks it received — exactly what the job page's "Enter
//   supplier invoice" does. No job expense as well (that would count it twice).
// - Otherwise: one job expense on the job, with the PDF as its receipt.
//
// The destination is either what the office typed ("PO-1008", "2542") or, when
// nothing is typed, the page's own match — recomputed here, never trusted from
// the browser. The invoice row is claimed first (read → costed) so two clicks
// or two people can't cost it twice; if anything after fails, it is put back.
//
// Office/admin only.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CATEGORIES = ["materials", "subcontractor", "equipment_hire", "other"] as const;
const PO_COLUMNS = "id, po_number, job_id, vendor_name, amount, status, invoice_number, xero_bill_id";
const route = "api/supplier-invoices/cost";

const fail = (error: string, status: number) => NextResponse.json({ error }, { status });

function poBlocked(po: PoCandidate): string | null {
  if (po.status === "cancelled") return `${po.po_number} was cancelled.`;
  if (po.xero_bill_id) return `${po.po_number} is already a bill in Xero.`;
  if (po.invoice_number) return `${po.po_number} already has invoice ${po.invoice_number}. Clear it on the job first if this one replaces it.`;
  return null;
}

export async function POST(request: NextRequest) {
  const guard = await requireOfficeOrAdmin(request);
  if (!guard.ok) return guard.response;

  const body = await request.json().catch(() => null);
  const id = typeof body?.id === "string" && UUID_RE.test(body.id) ? body.id : null;
  const target = typeof body?.target === "string" ? body.target.trim().slice(0, 40) : "";
  const category = CATEGORIES.find((c) => c === body?.category) ?? "materials";
  if (!id) return fail("Pick an invoice.", 400);

  const admin = createAdminClient();
  const got = await admin.from("supplier_invoices").select("*").eq("id", id).maybeSingle();
  if (got.error) { reportError(got.error, { route, step: "load" }); return fail("Could not load the invoice.", 500); }
  const inv = got.data;
  if (!inv) return fail("That invoice no longer exists.", 404);
  if (inv.status !== "read") return fail(inv.status === "costed" ? "That invoice is already costed." : "That invoice can't be costed.", 409);
  if (inv.doc_kind !== "invoice" && inv.doc_kind !== "credit_note") return fail("Only invoices and credit notes can be costed.", 400);
  if (inv.duplicate_of) return fail("This invoice was already received in an earlier file.", 409);
  const amount = Math.round(Number(inv.amount_ex_gst) * 100) / 100;
  if (!(amount > 0)) return fail("The amount wasn't read from this invoice. Enter it on the job instead.", 400);
  const gst = inv.gst_amount != null ? Math.round(Number(inv.gst_amount) * 100) / 100 : Math.round(amount * 10) / 100;
  const isCredit = inv.doc_kind === "credit_note";

  // Where it goes.
  let po: PoCandidate | null = null;
  let job: JobCandidate | null = null;
  if (target) {
    const t = parseTarget(target);
    if (t.job != null) {
      const r = await admin.from("jobs").select(JOB_COLUMNS).eq("job_number", t.job).maybeSingle();
      if (r.error) { reportError(r.error, { route, step: "job by number" }); return fail("Could not look up that job.", 500); }
      if (r.data) job = toJobCandidate(r.data as JobRow);
    }
    if (!job && t.po) {
      const r = await admin.from("vendor_orders").select(PO_COLUMNS).ilike("po_number", t.po).maybeSingle();
      if (r.error) { reportError(r.error, { route, step: "po by number" }); return fail("Could not look up that PO.", 500); }
      po = (r.data as PoCandidate | null) ?? null;
    }
    if (!job && !po) return fail(`No job or supplier PO "${target}".`, 404);
  } else {
    let cands;
    try {
      cands = await loadCandidates(admin, [inv]);
    } catch (e) {
      reportError(e, { route, step: "candidates" });
      return fail("Could not match the invoice.", 500);
    }
    const m = matchInvoice(inv, cands.pos, cands.jobs);
    if (m.kind === "none") return fail("This invoice isn't matched. Type a PO or job number.", 400);
    if (m.blocked) return fail(m.blocked, 409);
    if (m.kind === "po") po = m.po;
    else job = m.job;
  }
  if (po) {
    if (isCredit) return fail("A credit note can't go on a PO. Type the job number to add it as a credit on the job.", 400);
    const blocked = poBlocked(po);
    if (blocked) return fail(blocked, 409);
  }
  const jobId = po ? po.job_id : job!.id;

  // Claim it, so it can only be costed once.
  const claim = await admin
    .from("supplier_invoices")
    .update({ status: "costed", costed_by: guard.userId, costed_at: new Date().toISOString(), job_id: jobId, vendor_order_id: po?.id ?? null })
    .eq("id", id)
    .eq("status", "read")
    .select("id");
  if (claim.error) { reportError(claim.error, { route, step: "claim" }); return fail("Could not cost the invoice.", 500); }
  if (!claim.data?.length) return fail("Someone else just costed or dismissed this invoice.", 409);

  let copiedPath: string | null = null;
  const undo = async (step: string, err: unknown) => {
    reportError(err, { route, step });
    if (copiedPath) await admin.storage.from("job-documents").remove([copiedPath]);
    const back = await admin
      .from("supplier_invoices")
      .update({ status: "read", costed_by: null, costed_at: null, job_id: null, vendor_order_id: null, job_expense_id: null })
      .eq("id", id);
    if (back.error) reportError(back.error, { route, step: "undo claim" });
  };

  // The PDF goes on the job too. "expense-receipt-" keeps it out of
  // technicians' reach (0047's money-file rule), same as the job page.
  const pdf = await admin.storage.from("supplier-invoices").download(inv.storage_path);
  if (pdf.error || !pdf.data) { await undo("download", pdf.error); return fail("The PDF could not be found.", 500); }
  const safeName = String(inv.file_name).replace(/[^a-zA-Z0-9._-]/g, "_");
  const path = `${jobId}/expense-receipt-${po ? `${po.po_number}-` : ""}${Date.now()}_${safeName}`;
  const up = await admin.storage.from("job-documents").upload(path, pdf.data, { contentType: "application/pdf" });
  if (up.error) { await undo("copy pdf", up.error); return fail("Could not attach the PDF to the job.", 500); }
  copiedPath = path;

  if (po) {
    const upd = await admin
      .from("vendor_orders")
      .update({
        invoice_number: inv.invoice_number ?? "—",
        invoice_date: inv.invoice_date,
        amount,
        gst_amount: gst,
        invoice_storage_path: path,
        status: "received",
      }, { count: "exact" })
      .eq("id", po.id)
      .is("invoice_number", null)
      .is("xero_bill_id", null);
    if (upd.error || upd.count === 0) {
      await undo("po", upd.error ?? "po changed underneath");
      return fail(upd.error ? "Could not save the invoice on the PO." : `${po.po_number} changed just now. Reload and try again.`, upd.error ? 500 : 409);
    }
    return NextResponse.json({ ok: true, kind: "po", poNumber: po.po_number, jobId });
  }

  const sign = isCredit ? -1 : 1;
  const exp = await admin
    .from("job_expenses")
    .insert({
      job_id: jobId,
      supplier_name: inv.supplier_name ?? "Supplier",
      category,
      description: isCredit ? `Credit note${inv.invoice_number ? ` ${inv.invoice_number}` : ""}` : null,
      invoice_number: inv.invoice_number,
      invoice_date: inv.invoice_date,
      amount: sign * amount,
      gst_amount: sign * gst,
      receipt_storage_path: path,
      entered_by: guard.userId,
    })
    .select("id")
    .single();
  if (exp.error || !exp.data) { await undo("expense", exp.error); return fail("Could not add the expense to the job.", 500); }
  const link = await admin.from("supplier_invoices").update({ job_expense_id: exp.data.id }).eq("id", id);
  if (link.error) reportError(link.error, { route, step: "link expense" });
  return NextResponse.json({ ok: true, kind: "job", jobNumber: job!.job_number, jobId });
}
