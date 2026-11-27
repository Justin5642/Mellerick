// Supplier invoices from Gmail (0124, drafted) — the pure rules. No I/O here: what to
// take from an email, whether what the reader saw can be trusted, and whether
// it can be put on one of our supplier POs by itself. lib/gmail-invoices.ts
// does the Gmail, storage and database work around these.
//
// Never trust the reader blindly: an invoice is only filed on a PO by itself
// when it is ONE invoice, with an invoice number, an amount over $0 whose GST
// is ~10% and adds up to the total, a date that is not in the future, and
// exactly ONE of our PO numbers that exists, is open, has no invoice yet, is
// not in Xero, and is with the same supplier. Anything else goes to the
// review queue with a sentence saying why.

import { ourPoNumbers, supplierKey } from "./supplier-invoice-refs";
import type { ReadInvoice } from "./supplier-invoice-read";

/** Each attachment at most this (Gmail allows 25 MB; Claude's PDF limit is 32 MB). */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
/** Images smaller than this are signature logos, not invoices. */
export const MIN_IMAGE_BYTES = 30 * 1024;
/** The first run looks back this far; later runs from the last message read (minus a day). */
export const FIRST_RUN_LOOKBACK_DAYS = 7;
/** At most this many files are read with Claude in one run (hourly → ≤ 240 a day). */
export const MAX_READS_PER_RUN = 12;

export const DEFAULT_LABEL = "Supplier invoices";

export const SENTENCES = {
  reconnect: "Reconnect Google to allow reading supplier invoices (Settings → Google → Reconnect).",
  notConnected: "Google isn't connected, so supplier invoices can't be read from Gmail.",
  gmailApiOff: "The Gmail API isn't switched on in the Google Cloud project — turn it on, then try again.",
  gmailFailed: "Gmail couldn't be read just now. The next hourly check will try again.",
  noLabel: (label: string) => `There's no Gmail label called "${label}" in the connected mailbox.`,
  noAttachment: "No PDF or photo is attached to this email — enter it by hand if it's an invoice.",
  tooLarge: "This attachment is over 10 MB, too large to read — enter it by hand.",
  notReadable: "This attachment isn't a PDF, JPEG, PNG or WebP file, so it wasn't read.",
  readerOff: "The invoice reader isn't set up on the server, so this wasn't read — enter it by hand.",
  stopped: "The import stopped part-way through this one — check it and enter it by hand.",
} as const;

// ---------------------------------------------------------------- the email

export interface GmailPart {
  partId?: string | null;
  mimeType?: string | null;
  filename?: string | null;
  headers?: { name?: string | null; value?: string | null }[] | null;
  body?: { attachmentId?: string | null; size?: number | null; data?: string | null } | null;
  parts?: GmailPart[] | null;
}

export interface GmailMessage {
  id: string;
  internalDate?: string | null;
  payload?: GmailPart | null;
}

export interface AttachmentRef {
  partId: string;
  fileName: string;
  mimeType: string;
  size: number;
  attachmentId: string | null;
  /** Small attachments can arrive inline (base64url). */
  inlineData: string | null;
}

const PDF_TYPES = new Set(["application/pdf", "application/x-pdf"]);
const IMAGE_TYPES = new Set(["image/jpeg", "image/jpg", "image/png", "image/webp"]);

/** A header's value, by name (case-insensitive), from the top part. */
export function headerValue(msg: GmailMessage, name: string): string | null {
  const h = (msg.payload?.headers ?? []).find((x) => (x.name ?? "").toLowerCase() === name.toLowerCase());
  const v = (h?.value ?? "").trim();
  return v ? v : null;
}

/**
 * The attachments worth reading: named files that are PDFs or photos (by
 * type, or a .pdf/.jpg/.png/.webp name on a generic type). Small images are
 * signature logos and are skipped. Over-size files are KEPT here (the import
 * records them as "too large" rather than pretending they weren't there).
 */
export function pickAttachments(msg: GmailMessage): AttachmentRef[] {
  const out: AttachmentRef[] = [];
  const walk = (p: GmailPart | null | undefined) => {
    if (!p) return;
    const name = (p.filename ?? "").trim();
    const type = (p.mimeType ?? "").toLowerCase();
    if (name && p.body && (p.body.attachmentId || p.body.data)) {
      const ext = name.toLowerCase().split(".").pop() ?? "";
      const generic = type === "application/octet-stream" || type === "";
      const isPdf = PDF_TYPES.has(type) || (generic && ext === "pdf");
      const isImage = IMAGE_TYPES.has(type) || (generic && ["jpg", "jpeg", "png", "webp"].includes(ext));
      const size = Number(p.body.size ?? 0) || 0;
      if (isPdf || (isImage && size >= MIN_IMAGE_BYTES)) {
        out.push({
          partId: (p.partId ?? "").trim() || String(out.length + 1),
          fileName: name.slice(0, 300),
          mimeType: isPdf ? "application/pdf" : type || "image/jpeg",
          size,
          attachmentId: p.body.attachmentId ?? null,
          inlineData: p.body.attachmentId ? null : (p.body.data ?? null),
        });
      }
    }
    for (const c of p.parts ?? []) walk(c);
  };
  walk(msg.payload);
  return out;
}

/** Gmail's base64url → bytes. */
export function decodeBase64Url(data: string): Buffer {
  return Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

/** The search for a run: everything in the label after this instant (seconds). */
export function searchAfterSeconds(lastMessageAt: string | null, now: Date): number {
  const last = lastMessageAt ? Date.parse(lastMessageAt) : NaN;
  const from = Number.isFinite(last)
    ? last - 24 * 3600 * 1000 // a day of overlap; processed messages are skipped by id
    : now.getTime() - FIRST_RUN_LOOKBACK_DAYS * 24 * 3600 * 1000;
  return Math.floor(from / 1000);
}

export function safeFileName(name: string): string {
  const cleaned = name.replace(/[^a-zA-Z0-9._-]/g, "_").replace(/_+/g, "_").slice(-120);
  return cleaned || "invoice";
}

/** The job-documents path a PO's invoice lives at (the PO tab's own shape — 0047 hides it from technicians). */
export function jobDocumentPath(jobId: string, poNumber: string, fileName: string, nowMs: number): string {
  return `${jobId}/expense-receipt-${poNumber}-${nowMs}_${safeFileName(fileName)}`;
}

export function extensionFor(mime: string): string {
  return mime === "application/pdf" ? "pdf" : mime === "image/png" ? "png" : mime === "image/webp" ? "webp" : "jpg";
}

// ---------------------------------------------------------------- Google errors

export type GmailFailureKind = "scope" | "api_disabled" | "auth" | "other";

/**
 * What a Gmail API refusal means, from its status and Google's ENUMERATED
 * reasons only (never its message text, which is logged nowhere).
 */
export function classifyGmailFailure(status: number, reasons: string[]): GmailFailureKind {
  const r = reasons.map((x) => x.toLowerCase());
  if (status === 403 && r.some((x) => x === "insufficientpermissions" || x === "access_token_scope_insufficient")) return "scope";
  if (status === 403 && r.some((x) => x === "accessnotconfigured" || x === "service_disabled")) return "api_disabled";
  if (status === 401 || r.includes("invalid_grant")) return "auth";
  return "other";
}

/** Google's enumerated reasons from an error body (error.errors[].reason, error.details[].reason, error.status). */
export function googleErrorReasons(body: unknown): string[] {
  const e = (body as { error?: unknown } | null)?.error;
  if (!e || typeof e !== "object") return typeof e === "string" ? [e] : [];
  const err = e as { status?: unknown; errors?: unknown; details?: unknown };
  const out: string[] = [];
  const add = (v: unknown) => {
    if (typeof v === "string" && /^[A-Za-z_]{1,60}$/.test(v)) out.push(v);
  };
  add(err.status);
  for (const x of Array.isArray(err.errors) ? err.errors : []) add((x as { reason?: unknown })?.reason);
  for (const x of Array.isArray(err.details) ? err.details : []) add((x as { reason?: unknown })?.reason);
  return out;
}

/** Did the OAuth consent grant Gmail read? `scope` is the token response's space-separated list. */
export function grantsGmailRead(scope: string | null | undefined): boolean {
  return (scope ?? "").split(/\s+/).includes("https://www.googleapis.com/auth/gmail.readonly");
}

// ---------------------------------------------------------------- the invoice

export interface CheckedFields {
  doc_kind: ReadInvoice["doc_kind"] | null;
  supplier_name: string | null;
  invoice_number: string | null;
  invoice_date: string | null;
  amount_ex_gst: number | null;
  gst_amount: number | null;
  total: number | null;
  po_refs: string[];
  job_refs: string[];
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Melbourne's today as YYYY-MM-DD. */
export function melbourneToday(now: Date): string {
  return now.toLocaleDateString("en-CA", { timeZone: "Australia/Melbourne" });
}

/**
 * Check what the reader returned for one file. Answers the fields to store
 * (always — the office sees them even when they can't be trusted) and the
 * reason it can't be filed by itself, or null when it can.
 */
export function checkRead(reads: ReadInvoice[], today: string): { fields: CheckedFields; problem: string | null } {
  const first = reads[0];
  const fields: CheckedFields = {
    doc_kind: first?.doc_kind ?? null,
    supplier_name: first?.supplier_name ?? null,
    invoice_number: first?.invoice_number ?? null,
    invoice_date: first?.invoice_date ?? null,
    amount_ex_gst: first?.amount_ex_gst ?? null,
    gst_amount: first?.gst_amount ?? null,
    total: first?.total ?? null,
    po_refs: first ? ourPoNumbers(first.order_refs) : [],
    job_refs: first?.job_refs ?? [],
  };
  if (!first) return { fields, problem: "Nothing could be read from this file — enter it by hand." };
  if (reads.length > 1) return { fields, problem: `This file holds ${reads.length} documents — enter each one by hand.` };
  if (first.doc_kind === "credit_note") return { fields, problem: "This is a credit note — enter it by hand." };
  if (first.doc_kind === "statement") return { fields, problem: "This is a statement, not an invoice." };
  if (first.doc_kind !== "invoice") return { fields, problem: "This doesn't look like an invoice." };
  if (!fields.invoice_number) return { fields, problem: "No invoice number was read." };

  const amount = fields.amount_ex_gst;
  if (amount === null || !(amount > 0)) return { fields, problem: "No amount over $0 was read." };
  if (amount > 1_000_000) return { fields, problem: "The amount read is over $1,000,000 — check it." };
  if (fields.gst_amount === null) {
    // Not printed separately: 10%, as the PO tab's own form assumes.
    fields.gst_amount = round2(amount * 0.1);
  } else {
    const tolerance = Math.max(0.05, amount * 0.002);
    if (Math.abs(fields.gst_amount - amount * 0.1) > tolerance) {
      return { fields, problem: "The GST isn't 10% of the amount — check it (some lines may be GST-free)." };
    }
  }
  if (fields.total !== null && Math.abs(amount + fields.gst_amount - fields.total) > 0.05) {
    return { fields, problem: "The amount and GST don't add up to the total — check it." };
  }
  if (fields.invoice_date) {
    if (fields.invoice_date > today) return { fields, problem: "The invoice date is in the future — check it." };
    const twoYearsAgo = `${Number(today.slice(0, 4)) - 2}${today.slice(4)}`;
    if (fields.invoice_date < twoYearsAgo) return { fields, problem: "The invoice date is over two years ago — check it." };
  }
  return { fields, problem: null };
}

export interface CandidateOrder {
  id: string;
  po_number: string;
  job_id: string;
  vendor_name: string | null;
  status: string;
  invoice_number: string | null;
  xero_bill_id: string | null;
}

/** Why a PO can't take this invoice, or null. */
export function orderRefusal(order: CandidateOrder, invoiceNumber: string | null): string | null {
  if (order.status === "cancelled") return `${order.po_number} was cancelled.`;
  if (order.xero_bill_id) return `${order.po_number} is already a bill in Xero.`;
  if (order.invoice_number) {
    return invoiceNumber && order.invoice_number.trim().toLowerCase() === invoiceNumber.trim().toLowerCase()
      ? `This invoice is already entered on ${order.po_number}.`
      : `${order.po_number} already has invoice ${order.invoice_number}.`;
  }
  return null;
}

/** Same supplier, loosely ("Reece Pty Ltd" = "REECE PLUMBING"). Unknown on either side passes. */
export function sameSupplier(a: string | null, b: string | null): boolean {
  const ka = supplierKey(a);
  const kb = supplierKey(b);
  if (!ka || !kb) return true;
  return ka.includes(kb) || kb.includes(ka);
}

export type MatchDecision =
  | { kind: "matched"; order: CandidateOrder }
  | { kind: "review"; reason: string; order: CandidateOrder | null };

/**
 * Where a checked invoice goes. `orders` are the vendor orders whose number
 * is among fields.po_refs (looked up by the caller); `duplicate` says the same
 * supplier's invoice number was already received elsewhere.
 */
export function decideMatch(
  fields: CheckedFields,
  problem: string | null,
  orders: CandidateOrder[],
  duplicate: boolean,
): MatchDecision {
  const wanted = new Set(fields.po_refs.map((p) => p.toUpperCase()));
  const found = orders.filter((o) => wanted.has(o.po_number.toUpperCase()));
  const one = found.length === 1 ? found[0] : null;
  if (problem) return { kind: "review", reason: problem, order: one };
  if (duplicate) {
    return { kind: "review", reason: `Invoice ${fields.invoice_number} from this supplier was already received — check it isn't a copy.`, order: one };
  }
  if (fields.po_refs.length === 0) return { kind: "review", reason: "No PO number of ours is printed on it — assign it to a PO.", order: null };
  if (found.length === 0) return { kind: "review", reason: `${fields.po_refs.join(", ")} isn't one of our supplier POs.`, order: null };
  if (found.length > 1) return { kind: "review", reason: `It quotes more than one of our POs (${found.map((o) => o.po_number).join(", ")}) — assign it to the right one.`, order: null };
  const order = found[0];
  const refused = orderRefusal(order, fields.invoice_number);
  if (refused) return { kind: "review", reason: refused, order };
  if (!sameSupplier(fields.supplier_name, order.vendor_name)) {
    return { kind: "review", reason: `The invoice is from ${fields.supplier_name} but ${order.po_number} is with ${order.vendor_name}.`, order };
  }
  return { kind: "matched", order };
}

/** The vendor_orders patch an emailed invoice fills — always flagged for the office to check. */
export function orderInvoicePatch(fields: CheckedFields, path: string) {
  return {
    invoice_number: fields.invoice_number,
    invoice_date: fields.invoice_date,
    amount: fields.amount_ex_gst,
    gst_amount: fields.gst_amount ?? round2((fields.amount_ex_gst ?? 0) * 0.1),
    invoice_storage_path: path,
    status: "received" as const,
    invoice_needs_check: true,
  };
}

/** A typed PO number ("1234", "po1234", "PO-1234") as ours, or null. */
export function typedPoNumber(text: string): string | null {
  return ourPoNumbers([text.trim()])[0] ?? null;
}
