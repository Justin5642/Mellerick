// Supplier invoices from Gmail (0124, drafted, Justin 27 Nov 2026).
//
// Bills land in a Gmail LABEL in the accounts mailbox ("Supplier invoices" by
// default, set in Settings → Google). Every hour /api/gmail/poll-invoices runs
// importGmailInvoices: list the label's messages since the last one read,
// skip any already recorded, take each PDF / photo attachment, keep the file
// in the office-only supplier-invoices bucket (0103), read it with Claude
// (lib/supplier-invoice-read.ts) and check what was read
// (lib/gmail-invoice-rules.ts). When it quotes exactly one of OUR supplier
// POs that is waiting for its invoice, the invoice is filled in on that PO —
// file copied to the job at the PO tab's own path — and flagged
// invoice_needs_check, so the office checks it before "Send to Xero". It is
// never sent to Xero from here. Everything else goes to the review queue on
// Supplier POs.
//
// Read-only toward Gmail (gmail.readonly): nothing is moved, labelled or
// marked read. Idempotent: (message id, attachment part id) is unique, and a
// message with any row is not read again. Nothing from an email — sender,
// subject, file name, amounts — is ever sent to error monitoring (tags only)
// or logged; Google's error text isn't logged either (status + enumerated
// reasons only).

import type { SupabaseClient } from "@supabase/supabase-js";
import { getGoogleAuthClient } from "@/lib/google";
import { reportError, reportFailure } from "@/lib/monitoring";
import { sniffServiceInvoiceMime } from "@/lib/service-invoice-read";
import {
  MAX_SUPPLIER_IMAGE_BYTES,
  readSupplierInvoiceFile,
  SupplierInvoiceReadError,
  supplierKey,
  type ReadInvoice,
  type SupplierInvoiceMime,
} from "@/lib/supplier-invoice-read";
import {
  checkRead,
  classifyGmailFailure,
  decideCredit,
  decideJobOnly,
  decideMatch,
  decodeBase64Url,
  DEFAULT_LABEL,
  extensionFor,
  googleErrorReasons,
  headerValue,
  jobDocumentPath,
  MAX_ATTACHMENT_BYTES,
  MAX_READS_PER_RUN,
  melbourneToday,
  orderInvoicePatch,
  pickAttachments,
  searchAfterSeconds,
  SENTENCES,
  STATEMENT_REASON,
  type AttachmentRef,
  type CandidateJob,
  type CandidateOrder,
  type CheckedFields,
  type GmailFailureKind,
  type GmailMessage,
} from "@/lib/gmail-invoice-rules";

const ROUTE = "api/gmail/poll-invoices";
const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";
const MISSING_TABLE = new Set(["42P01", "PGRST205"]);
const MAX_MESSAGES_LISTED = 200;
/** A row left 'new' this long by a run that died is handed to the office. */
const STUCK_MS = 30 * 60_000;

export const ORDER_COLUMNS = "id, po_number, job_id, vendor_name, status, invoice_number, xero_bill_id, amount";
export const JOB_COLUMNS = "id, job_number, status, actual_end, updated_at";

export class GmailTablesMissing extends Error {
  constructor() {
    super("Gmail invoice tables not found");
  }
}

/** A refused Gmail call: status + Google's enumerated reasons, never its text. */
export class GmailHttpError extends Error {
  constructor(readonly status: number, readonly kind: GmailFailureKind) {
    super(`Gmail API ${status} (${kind})`);
  }
}

// ---------------------------------------------------------------- Gmail API

export interface GmailApi {
  listLabels(): Promise<{ id: string; name: string }[]>;
  listMessageIds(labelId: string, afterSeconds: number, max: number): Promise<string[]>;
  getMessage(id: string): Promise<GmailMessage>;
  getAttachment(messageId: string, attachmentId: string): Promise<string>;
}

/** The Gmail REST API with a bearer token. `fetchImpl` is for tests. */
export function gmailApi(token: string, fetchImpl: typeof fetch = fetch): GmailApi {
  async function get<T>(path: string): Promise<T> {
    const res = await fetchImpl(`${GMAIL}${path}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      throw new GmailHttpError(res.status, classifyGmailFailure(res.status, googleErrorReasons(body)));
    }
    return (await res.json()) as T;
  }
  return {
    async listLabels() {
      const r = await get<{ labels?: { id?: string; name?: string }[] }>("/labels");
      return (r.labels ?? []).filter((l) => l.id && l.name).map((l) => ({ id: l.id!, name: l.name! }));
    },
    async listMessageIds(labelId, afterSeconds, max) {
      const ids: string[] = [];
      let pageToken: string | undefined;
      do {
        const q = new URLSearchParams({ labelIds: labelId, q: `after:${afterSeconds}`, maxResults: "100" });
        if (pageToken) q.set("pageToken", pageToken);
        const r = await get<{ messages?: { id?: string }[]; nextPageToken?: string }>(`/messages?${q}`);
        for (const m of r.messages ?? []) if (m.id) ids.push(m.id);
        pageToken = r.nextPageToken;
      } while (pageToken && ids.length < max);
      return ids.slice(0, max);
    },
    getMessage(id) {
      return get<GmailMessage>(`/messages/${encodeURIComponent(id)}?format=full`);
    },
    async getAttachment(messageId, attachmentId) {
      const r = await get<{ data?: string }>(
        `/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`,
      );
      return r.data ?? "";
    },
  };
}

/** The connected Google account's Gmail, or null when Google isn't connected. */
export async function connectedGmail(): Promise<GmailApi | null> {
  const auth = await getGoogleAuthClient();
  if (!auth) return null;
  const { token } = await auth.getAccessToken();
  if (!token) return null;
  return gmailApi(token);
}

// ---------------------------------------------------------------- settings

export interface GmailSettings {
  label_name: string;
  gmail_allowed: boolean | null;
  last_poll_at: string | null;
  last_ok_at: string | null;
  last_error: string | null;
  last_message_at: string | null;
  last_imported: number | null;
}

async function saveState(db: SupabaseClient, patch: Partial<GmailSettings>) {
  const { error } = await db.from("gmail_invoice_settings").update(patch).eq("id", true);
  if (error) reportError(error, { route: ROUTE, step: "save state" });
}

/**
 * After a Google (re)connect: remember whether Gmail reading was granted.
 * Best-effort — before 0124 (a draft) is applied the table isn't there and nothing is recorded.
 */
export async function recordGmailScope(db: SupabaseClient, granted: boolean): Promise<void> {
  const { error } = await db
    .from("gmail_invoice_settings")
    .update({ gmail_allowed: granted, last_error: granted ? null : SENTENCES.reconnect })
    .eq("id", true);
  if (error && !MISSING_TABLE.has(error.code ?? "")) reportError(error, { route: "api/google/callback", step: "gmail scope" });
}

// ---------------------------------------------------------------- import

export type ReadFile = (file: Buffer, mime: SupplierInvoiceMime) => Promise<ReadInvoice[]>;

export interface ImportDeps {
  db: SupabaseClient;
  /** null = Google isn't connected. */
  gmail: GmailApi | null;
  read: ReadFile | null;
  now?: () => Date;
  /** Stop starting new messages after this long. */
  budgetMs?: number;
  maxReads?: number;
}

export interface ImportResult {
  skipped?: boolean;
  reason?: string;
  messages: number;
  files: number;
  matched: number;
  needsReview: number;
  /** Supplier statements put away by themselves. */
  dismissed: number;
  more: boolean;
}

const emptyResult = (): ImportResult => ({ messages: 0, files: 0, matched: 0, needsReview: 0, dismissed: 0, more: false });

/** Shrink a photo to fit Claude's image limit; PDFs are passed as they are. */
async function fitForReader(file: Buffer, mime: SupplierInvoiceMime): Promise<{ file: Buffer; mime: SupplierInvoiceMime }> {
  if (mime === "application/pdf" || file.length <= MAX_SUPPLIER_IMAGE_BYTES) return { file, mime };
  const sharp = (await import("sharp")).default;
  const out = await sharp(file).rotate().resize({ width: 2400, height: 2400, fit: "inside", withoutEnlargement: true }).jpeg({ quality: 80 }).toBuffer();
  return { file: out, mime: "image/jpeg" };
}

/**
 * One hourly run. Throws GmailTablesMissing before 0124 (a draft) is applied; every
 * other failure is recorded in gmail_invoice_settings.last_error as a fixed
 * sentence and the result says skipped.
 */
export async function importGmailInvoices(deps: ImportDeps): Promise<ImportResult> {
  const { db } = deps;
  const now = deps.now ?? (() => new Date());
  const started = now().getTime();
  const budgetMs = deps.budgetMs ?? 200_000;
  const maxReads = deps.maxReads ?? MAX_READS_PER_RUN;
  const result = emptyResult();

  const settingsRead = await db.from("gmail_invoice_settings").select("*").eq("id", true).maybeSingle();
  if (settingsRead.error) {
    if (MISSING_TABLE.has(settingsRead.error.code ?? "")) throw new GmailTablesMissing();
    throw settingsRead.error;
  }
  const settings = (settingsRead.data ?? { label_name: DEFAULT_LABEL, last_message_at: null }) as GmailSettings;
  const pollAt = now().toISOString();

  // Rows a dead run left half-done go to the office instead of hanging forever.
  const stuck = await db
    .from("gmail_supplier_invoices")
    .update({ status: "needs_review", review_reason: SENTENCES.stopped, updated_at: pollAt })
    .eq("status", "new")
    .lt("created_at", new Date(started - STUCK_MS).toISOString());
  if (stuck.error) reportError(stuck.error, { route: ROUTE, step: "stuck rows" });

  if (!deps.gmail) {
    await saveState(db, { last_poll_at: pollAt, last_error: SENTENCES.notConnected });
    return { ...result, skipped: true, reason: "not connected" };
  }

  const fail = async (err: unknown, step: string): Promise<ImportResult> => {
    const kind = err instanceof GmailHttpError ? err.kind : "other";
    const sentence = kind === "scope" ? SENTENCES.reconnect : kind === "api_disabled" ? SENTENCES.gmailApiOff : SENTENCES.gmailFailed;
    if (kind !== "scope") {
      console.error("gmail import failed:", err instanceof GmailHttpError ? err.message : "unexpected error", step);
      reportError(err instanceof GmailHttpError ? new Error(err.message) : err, { route: ROUTE, integration: "gmail", step });
    }
    await saveState(db, {
      last_poll_at: pollAt,
      last_error: sentence,
      ...(kind === "scope" ? { gmail_allowed: false } : {}),
    });
    return { ...result, skipped: true, reason: kind };
  };

  // The label.
  let labelId: string;
  try {
    const labels = await deps.gmail.listLabels();
    const want = settings.label_name.trim().toLowerCase();
    const label = labels.find((l) => l.name.trim().toLowerCase() === want);
    if (!label) {
      await saveState(db, { last_poll_at: pollAt, last_error: SENTENCES.noLabel(settings.label_name), gmail_allowed: true });
      return { ...result, skipped: true, reason: "no label" };
    }
    labelId = label.id;
  } catch (err) {
    return fail(err, "labels");
  }

  // The label's messages since the last one read, minus those already recorded.
  let ids: string[];
  try {
    ids = await deps.gmail.listMessageIds(labelId, searchAfterSeconds(settings.last_message_at, now()), MAX_MESSAGES_LISTED);
  } catch (err) {
    return fail(err, "list");
  }
  const seen = new Set<string>();
  for (let i = 0; i < ids.length; i += 100) {
    const r = await db.from("gmail_supplier_invoices").select("gmail_message_id").in("gmail_message_id", ids.slice(i, i + 100));
    if (r.error) {
      reportError(r.error, { route: ROUTE, step: "seen" });
      await saveState(db, { last_poll_at: pollAt, last_error: SENTENCES.gmailFailed });
      return { ...result, skipped: true, reason: "database" };
    }
    for (const row of (r.data ?? []) as { gmail_message_id: string }[]) seen.add(row.gmail_message_id);
  }
  // Gmail lists newest first; oldest first here, so the resume point only moves forward.
  const todo = ids.filter((id) => !seen.has(id)).reverse();

  let cursor = settings.last_message_at;
  let reads = 0;
  for (const id of todo) {
    if (now().getTime() - started > budgetMs || reads >= maxReads) {
      result.more = true;
      break;
    }
    let msg: GmailMessage;
    try {
      msg = await deps.gmail.getMessage(id);
    } catch (err) {
      const r = await fail(err, "message");
      return { ...r, messages: result.messages, files: result.files, matched: result.matched, needsReview: result.needsReview, dismissed: result.dismissed };
    }
    const outcome = await importMessage(deps, msg, maxReads - reads, now);
    if (outcome === "claimed-elsewhere") continue;
    reads += outcome.reads;
    result.messages += 1;
    result.files += outcome.files;
    result.matched += outcome.matched;
    result.needsReview += outcome.needsReview;
    result.dismissed += outcome.dismissed;
    const at = msg.internalDate ? new Date(Number(msg.internalDate)).toISOString() : null;
    if (at && (!cursor || at > cursor)) cursor = at;
  }

  await saveState(db, {
    last_poll_at: pollAt,
    last_ok_at: pollAt,
    last_error: null,
    gmail_allowed: true,
    last_message_at: cursor,
    last_imported: result.files,
  });
  return result;
}

type MessageOutcome = { reads: number; files: number; matched: number; needsReview: number; dismissed: number } | "claimed-elsewhere";

async function importMessage(deps: ImportDeps, msg: GmailMessage, readsLeft: number, now: () => Date): Promise<MessageOutcome> {
  const { db } = deps;
  const base = {
    gmail_message_id: msg.id,
    received_at: msg.internalDate ? new Date(Number(msg.internalDate)).toISOString() : null,
    sender: headerValue(msg, "From")?.slice(0, 500) ?? null,
    subject: headerValue(msg, "Subject")?.slice(0, 1000) ?? null,
  };
  const out = { reads: 0, files: 0, matched: 0, needsReview: 0, dismissed: 0 };
  const attachments = pickAttachments(msg);

  if (attachments.length === 0) {
    const ins = await db.from("gmail_supplier_invoices").insert({ ...base, part_id: "-", status: "needs_review", review_reason: SENTENCES.noAttachment });
    if (ins.error?.code === "23505") return "claimed-elsewhere";
    if (ins.error) reportError(ins.error, { route: ROUTE, step: "record email" });
    out.needsReview += 1;
    return out;
  }

  for (const att of attachments) {
    // Claim the attachment first: the unique (message, part) makes a second
    // run running at the same time skip it.
    const claim = await db
      .from("gmail_supplier_invoices")
      .insert({ ...base, part_id: att.partId, file_name: att.fileName, mime_type: att.mimeType, status: "new" })
      .select("id")
      .single();
    if (claim.error?.code === "23505") {
      if (out.files === 0) return "claimed-elsewhere";
      continue;
    }
    if (claim.error || !claim.data) {
      reportError(claim.error, { route: ROUTE, step: "claim" });
      continue;
    }
    out.files += 1;
    const rowId = (claim.data as { id: string }).id;
    const useRead = out.reads < readsLeft;
    const r = await importAttachment(deps, msg.id, rowId, att, useRead, now);
    if (r.read) out.reads += 1;
    if (r.status === "matched") out.matched += 1;
    else if (r.status === "dismissed") out.dismissed += 1;
    else out.needsReview += 1;
  }
  return out;
}

async function finish(db: SupabaseClient, rowId: string, patch: Record<string, unknown>) {
  const { error } = await db.from("gmail_supplier_invoices").update({ ...patch, updated_at: new Date().toISOString() }).eq("id", rowId);
  if (error) reportError(error, { route: ROUTE, step: "finish row" });
}

async function importAttachment(
  deps: ImportDeps,
  messageId: string,
  rowId: string,
  att: AttachmentRef,
  mayRead: boolean,
  now: () => Date,
): Promise<{ status: "matched" | "needs_review" | "dismissed"; read: boolean }> {
  const { db } = deps;
  const review = async (reason: string, extra: Record<string, unknown> = {}) => {
    await finish(db, rowId, { status: "needs_review", review_reason: reason, ...extra });
    return { status: "needs_review" as const, read: false };
  };

  if (att.size > MAX_ATTACHMENT_BYTES) return review(SENTENCES.tooLarge);

  // The bytes.
  let file: Buffer;
  try {
    const data = att.inlineData ?? (att.attachmentId ? await deps.gmail!.getAttachment(messageId, att.attachmentId) : "");
    file = decodeBase64Url(data);
  } catch (err) {
    reportError(err instanceof GmailHttpError ? new Error(err.message) : err, { route: ROUTE, integration: "gmail", step: "attachment" });
    return review(SENTENCES.gmailFailed, { error: "attachment download failed" });
  }
  if (file.length === 0) return review(SENTENCES.notReadable);
  if (file.length > MAX_ATTACHMENT_BYTES) return review(SENTENCES.tooLarge);
  const mime = sniffServiceInvoiceMime(file);
  if (!mime) return review(SENTENCES.notReadable);

  // Keep the original (office-only bucket) whatever happens next.
  const day = melbourneToday(now());
  const storagePath = `gmail/${day}/${rowId}.${extensionFor(mime)}`;
  const up = await db.storage.from("supplier-invoices").upload(storagePath, file, { contentType: mime, upsert: true });
  if (up.error) {
    reportError(up.error, { route: ROUTE, step: "store file" });
    return review("The file couldn't be saved — open the email and enter it by hand.", { error: "storage upload failed" });
  }
  await finish(db, rowId, { storage_path: storagePath, mime_type: mime });

  if (!deps.read) return review(SENTENCES.readerOff);
  if (!mayRead) {
    // This run's reading allowance is used up mid-email. Rows are never read
    // twice, so it goes to the office now rather than waiting silently.
    return review("Too many invoices arrived at once to read them all — enter this one by hand.");
  }

  // Read it.
  let reads: ReadInvoice[];
  try {
    const fit = await fitForReader(file, mime);
    reads = await deps.read(fit.file, fit.mime);
  } catch (err) {
    if (err instanceof SupplierInvoiceReadError) return { ...(await review(err.message)), read: true };
    reportError(err, { route: ROUTE, integration: "anthropic", step: "read" });
    return { ...(await review("The invoice reader couldn't read this one just now — enter it by hand.", { error: "reader failed" })), read: true };
  }

  const { fields, problem, statement } = checkRead(reads, melbourneToday(now()));
  const stored = {
    doc_kind: fields.doc_kind,
    supplier_name: fields.supplier_name,
    invoice_number: fields.invoice_number,
    invoice_date: fields.invoice_date,
    amount_ex_gst: fields.amount_ex_gst,
    gst_amount: fields.gst_amount,
    total: fields.total,
    po_refs: fields.po_refs,
    job_refs: fields.job_refs,
  };

  // A supplier statement is not a bill: put away by itself, kept in the
  // Dismissed list (Reopen brings it back).
  if (statement) {
    await finish(db, rowId, { ...stored, status: "dismissed", review_reason: STATEMENT_REASON });
    return { status: "dismissed", read: true };
  }

  const orders = await loadOrders(db, fields.po_refs);

  // A credit note is only ever OFFERED to the office (Apply credit to PO);
  // nothing is written to the PO here.
  if (fields.doc_kind === "credit_note") {
    const credit = orders === null
      ? { kind: "review" as const, reason: "Our supplier POs couldn't be checked just now — enter this credit note by hand." }
      : decideCredit(fields, problem, orders);
    await finish(db, rowId, {
      ...stored,
      status: "needs_review",
      review_reason: credit.reason,
      vendor_order_id: credit.kind === "credit" ? credit.order.id : null,
      job_id: credit.kind === "credit" ? credit.order.job_id : null,
    });
    return { status: "needs_review", read: true };
  }

  const duplicate = orders === null ? false : await isDuplicate(db, fields, rowId);
  const decision = orders === null
    ? { kind: "review" as const, reason: "Our supplier POs couldn't be checked just now — assign it to a PO.", order: null }
    : decideMatch(fields, problem, orders, duplicate);

  // No PO of ours on it, but one of our job numbers: offer it to the office
  // as a job expense (Add as job expense). Only for an invoice that checked
  // out and isn't a repeat.
  if (decision.kind === "review" && !decision.order && orders !== null && !problem && !duplicate
      && !orders.some((o) => fields.po_refs.includes(o.po_number.toUpperCase()))
      && (fields.job_numbers ?? []).length > 0) {
    const jobs = await loadJobs(db, fields.job_numbers ?? []);
    const jobOnly = jobs === null ? { kind: "review" as const, reason: decision.reason } : decideJobOnly(fields, jobs, decision.reason, now());
    await finish(db, rowId, {
      ...stored,
      status: "needs_review",
      review_reason: jobOnly.reason,
      vendor_order_id: null,
      job_id: jobOnly.kind === "job_expense" ? jobOnly.job.id : null,
    });
    return { status: "needs_review", read: true };
  }

  if (decision.kind === "review") {
    await finish(db, rowId, {
      ...stored,
      status: "needs_review",
      review_reason: decision.reason,
      vendor_order_id: decision.order?.id ?? null,
      job_id: decision.order?.job_id ?? null,
    });
    return { status: "needs_review", read: true };
  }

  const filed = await fileOnOrder(db, decision.order, fields, file, mime, att.fileName, now().getTime());
  if (!filed.ok) {
    await finish(db, rowId, { ...stored, status: "needs_review", review_reason: filed.reason, vendor_order_id: decision.order.id, job_id: decision.order.job_id });
    return { status: "needs_review", read: true };
  }
  await finish(db, rowId, {
    ...stored,
    status: "matched",
    review_reason: null,
    vendor_order_id: decision.order.id,
    job_id: decision.order.job_id,
    job_document_path: filed.path,
  });
  return { status: "matched", read: true };
}

/** Our jobs with these numbers; null when they couldn't be read. */
export async function loadJobs(db: SupabaseClient, jobNumbers: number[]): Promise<CandidateJob[] | null> {
  if (jobNumbers.length === 0) return [];
  const r = await db.from("jobs").select(JOB_COLUMNS).in("job_number", jobNumbers.slice(0, 20));
  if (r.error) {
    reportError(r.error, { route: ROUTE, step: "jobs" });
    return null;
  }
  return (r.data ?? []) as CandidateJob[];
}

/** The vendor orders with these PO numbers; null when they couldn't be read. */
export async function loadOrders(db: SupabaseClient, poNumbers: string[]): Promise<CandidateOrder[] | null> {
  if (poNumbers.length === 0) return [];
  const r = await db.from("vendor_orders").select(ORDER_COLUMNS).in("po_number", poNumbers);
  if (r.error) {
    reportError(r.error, { route: ROUTE, step: "orders" });
    return null;
  }
  return (r.data ?? []) as CandidateOrder[];
}

/**
 * The same supplier's invoice number already received: on any PO, from an
 * upload (0103) or another email. A failed check counts as "not a duplicate"
 * only because the PO's own "no invoice yet" condition still guards the write.
 */
async function isDuplicate(db: SupabaseClient, fields: CheckedFields, rowId: string): Promise<boolean> {
  const num = fields.invoice_number;
  if (!num) return false;
  const key = supplierKey(fields.supplier_name);
  const same = (n: string | null, supplier: string | null) =>
    (n ?? "").trim().toLowerCase() === num.trim().toLowerCase() && (!key || !supplierKey(supplier) || supplierKey(supplier) === key);
  const [emails, uploads, orders] = await Promise.all([
    db.from("gmail_supplier_invoices").select("id, invoice_number, supplier_name").ilike("invoice_number", num).in("status", ["matched", "needs_review"]).neq("id", rowId),
    db.from("supplier_invoices").select("invoice_number, supplier_name").ilike("invoice_number", num).in("status", ["read", "costed"]),
    db.from("vendor_orders").select("invoice_number, vendor_name").ilike("invoice_number", num),
  ]);
  for (const r of [emails, uploads, orders]) if (r.error && !MISSING_TABLE.has(r.error.code ?? "")) reportError(r.error, { route: ROUTE, step: "duplicate" });
  return (
    ((emails.data ?? []) as { invoice_number: string | null; supplier_name: string | null }[]).some((x) => same(x.invoice_number, x.supplier_name)) ||
    ((uploads.data ?? []) as { invoice_number: string | null; supplier_name: string | null }[]).some((x) => same(x.invoice_number, x.supplier_name)) ||
    ((orders.data ?? []) as { invoice_number: string | null; vendor_name: string | null }[]).some((x) => same(x.invoice_number, x.vendor_name))
  );
}

/**
 * Put the invoice on its PO: the file to job-documents at the PO tab's path,
 * then the PO's invoice fields — ONLY while the PO still has no invoice and
 * no Xero bill (checked in the UPDATE itself, so an invoice the office typed
 * in meanwhile is never overwritten). On a refusal the copied file is removed.
 */
export async function fileOnOrder(
  db: SupabaseClient,
  order: CandidateOrder,
  fields: CheckedFields,
  file: Buffer,
  mime: string,
  fileName: string,
  nowMs: number,
): Promise<{ ok: true; path: string } | { ok: false; reason: string }> {
  const path = jobDocumentPath(order.job_id, order.po_number, fileName, nowMs);
  const up = await db.storage.from("job-documents").upload(path, file, { contentType: mime });
  if (up.error) {
    reportError(up.error, { route: ROUTE, step: "copy to job" });
    return { ok: false, reason: `The file couldn't be attached to ${order.po_number}'s job — assign it again.` };
  }
  const upd = await db
    .from("vendor_orders")
    .update(orderInvoicePatch(fields, path), { count: "exact" })
    .eq("id", order.id)
    .is("invoice_number", null)
    .is("xero_bill_id", null)
    .neq("status", "cancelled");
  if (upd.error || upd.count === 0) {
    await db.storage.from("job-documents").remove([path]);
    if (upd.error) {
      reportError(upd.error, { route: ROUTE, step: "fill PO" });
      return { ok: false, reason: `The invoice couldn't be saved on ${order.po_number} — assign it again.` };
    }
    return { ok: false, reason: `${order.po_number} got an invoice in the meantime — check this one isn't a copy.` };
  }
  return { ok: true, path };
}

/** The reader the cron uses, or null when ANTHROPIC_API_KEY isn't set (reported once a run). */
export function defaultReader(): ReadFile | null {
  if (!process.env.ANTHROPIC_API_KEY) {
    reportFailure("ANTHROPIC_API_KEY is not configured", { route: ROUTE, integration: "anthropic" });
    return null;
  }
  return (file, mime) => readSupplierInvoiceFile(file, mime);
}
