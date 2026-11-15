import { NextRequest, NextResponse } from "next/server";
import { requireOfficeOrAdmin } from "@/lib/api/guards";
import { createAdminClient } from "@/lib/supabase/admin";
import { consumeRateLimit, rateLimitedResponse, SUPPLIER_INVOICE_READ_LIMIT } from "@/lib/api/rate-limit";
import { reportError, reportFailure } from "@/lib/monitoring";
import { readSupplierInvoicePdf, SupplierInvoiceReadError, supplierKey } from "@/lib/supplier-invoice-read";

// Read one uploaded supplier PDF (0103).
//
// The browser has already put the file in the private supplier-invoices
// bucket (office/admin only). This reads it back with the service role, sends
// it to Claude once, and records one supplier_invoices row per invoice found.
// The same file (by SHA-256) is never read twice: its existing rows come back.
//
// Office/admin only. Errors are reported to the screen in plain words; the
// database's own messages are logged, not returned.

export const maxDuration = 120;

const PATH_RE = /^\d{4}-\d{2}-\d{2}\/[0-9a-f-]{36}\.pdf$/;
const SHA_RE = /^[0-9a-f]{64}$/;

export async function POST(request: NextRequest) {
  const guard = await requireOfficeOrAdmin(request);
  if (!guard.ok) return guard.response;

  const body = await request.json().catch(() => null);
  const storagePath = typeof body?.storagePath === "string" ? body.storagePath : "";
  const fileName = typeof body?.fileName === "string" ? body.fileName.slice(0, 200) : "";
  if (!PATH_RE.test(storagePath) || !fileName) {
    return NextResponse.json({ error: "Upload the PDF first, then read it." }, { status: 400 });
  }

  const admin = createAdminClient();

  const file = await admin.storage.from("supplier-invoices").download(storagePath);
  if (file.error || !file.data) {
    reportFailure("supplier invoice download failed", { route: "api/supplier-invoices/read", detail: file.error?.message });
    return NextResponse.json({ error: "The uploaded PDF could not be found. Upload it again." }, { status: 404 });
  }
  const pdf = Buffer.from(await file.data.arrayBuffer());
  if (pdf.subarray(0, 5).toString("latin1") !== "%PDF-") {
    return NextResponse.json({ error: `${fileName} is not a PDF.` }, { status: 415 });
  }
  const { createHash } = await import("node:crypto");
  const sha = createHash("sha256").update(pdf).digest("hex");
  if (!SHA_RE.test(sha)) return NextResponse.json({ error: "Could not fingerprint the file." }, { status: 500 });

  // Dropped before? Return what was read then, and drop the new copy.
  const seen = await admin.from("supplier_invoices").select("*").eq("file_sha256", sha).order("index_in_file");
  if (seen.error) {
    reportError(seen.error, { route: "api/supplier-invoices/read", step: "dedupe" });
    return NextResponse.json({ error: "Could not check whether this file was already read." }, { status: 500 });
  }
  const seenRows = seen.data ?? [];
  if (seenRows.length > 0 && seenRows.every((r) => r.status === "failed")) {
    // Only a failed read is on record (a reader outage, a timeout): read it
    // again rather than answering "already read" for ever (audit, 15 Nov
    // 2026). The failure rows go; this upload becomes the file of record.
    const del = await admin.from("supplier_invoices").delete().eq("file_sha256", sha).eq("status", "failed");
    if (del.error) {
      reportError(del.error, { route: "api/supplier-invoices/read", step: "clear failed read" });
      return NextResponse.json({ error: "Could not retry this file. Try again." }, { status: 500 });
    }
    const oldPaths = [...new Set(seenRows.map((r) => r.storage_path))].filter((p) => p !== storagePath);
    if (oldPaths.length) await admin.storage.from("supplier-invoices").remove(oldPaths);
  } else if (seenRows.length > 0) {
    if (seenRows[0].storage_path !== storagePath) await admin.storage.from("supplier-invoices").remove([storagePath]);
    return NextResponse.json({ alreadyRead: true, invoices: seenRows });
  }

  if (!(await consumeRateLimit(guard.userId, SUPPLIER_INVOICE_READ_LIMIT))) return rateLimitedResponse();
  if (!process.env.ANTHROPIC_API_KEY) {
    reportFailure("ANTHROPIC_API_KEY is not configured", { route: "api/supplier-invoices/read", integration: "anthropic" });
    return NextResponse.json({ error: "The invoice reader is not set up on the server." }, { status: 500 });
  }

  const base = { storage_path: storagePath, file_name: fileName, file_sha256: sha, uploaded_by: guard.userId };

  let read;
  try {
    read = await readSupplierInvoicePdf(pdf);
  } catch (e) {
    const message = e instanceof SupplierInvoiceReadError ? e.message : "The reader could not be reached. Try again in a minute.";
    if (!(e instanceof SupplierInvoiceReadError)) reportError(e, { route: "api/supplier-invoices/read", integration: "anthropic" });
    // Record the failure so the file is not lost from the list.
    const failed = await admin.from("supplier_invoices").insert({ ...base, status: "failed", read_error: message }).select("*");
    if (failed.error) reportError(failed.error, { route: "api/supplier-invoices/read", step: "record failure" });
    return NextResponse.json({ error: message, invoices: failed.data ?? [] }, { status: 502 });
  }

  if (read.length === 0) {
    read = [{ doc_kind: "other", supplier_name: null, supplier_abn: null, invoice_number: null, invoice_date: null, amount_ex_gst: null, gst_amount: null, total: null, order_refs: [], job_refs: [], site_text: null }];
  }

  const rows = read.map((r, i) => ({
    ...base,
    index_in_file: i,
    status: "read",
    doc_kind: r.doc_kind,
    supplier_name: r.supplier_name,
    supplier_abn: r.supplier_abn,
    invoice_number: r.invoice_number,
    invoice_date: r.invoice_date,
    amount_ex_gst: r.amount_ex_gst,
    gst_amount: r.gst_amount,
    total: r.total,
    po_refs: r.order_refs,
    job_refs: r.job_refs,
    site_text: r.site_text,
    extracted: r,
  }));

  // The same invoice re-sent in a different file: link it to the first copy.
  const numbers = rows.map((r) => r.invoice_number).filter((n): n is string => !!n);
  if (numbers.length > 0) {
    const prior = await admin
      .from("supplier_invoices")
      .select("id, supplier_name, invoice_number")
      .in("invoice_number", numbers)
      .is("duplicate_of", null);
    if (prior.error) reportError(prior.error, { route: "api/supplier-invoices/read", step: "duplicate check" });
    for (const row of rows) {
      const first = (prior.data ?? []).find(
        (p) => p.invoice_number?.toLowerCase() === row.invoice_number?.toLowerCase() && supplierKey(p.supplier_name) === supplierKey(row.supplier_name)
      );
      if (first) Object.assign(row, { duplicate_of: first.id });
    }
  }

  const saved = await admin.from("supplier_invoices").insert(rows).select("*").order("index_in_file");
  if (saved.error) {
    reportError(saved.error, { route: "api/supplier-invoices/read", step: "save" });
    return NextResponse.json({ error: "The PDF was read but the results did not save. Try again." }, { status: 500 });
  }
  return NextResponse.json({ alreadyRead: false, invoices: saved.data });
}
