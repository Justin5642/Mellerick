import * as FileSystem from "expo-file-system/legacy";
import { supabase } from "./supabase";
import { fetchWithTimeout } from "./fetchWithTimeout";
import {
  ATTACHMENT_ACCEPT,
  ATTACHMENT_HINT,
  MAX_ATTACHMENTS,
  MAX_ATTACHMENT_TOTAL_BYTES,
  cleanAttachmentName,
  formatBytes,
  parseExtraAttachments,
  type ExtraAttachment,
} from "./invoiceAttachments";

// Send Invoice on the phone (office/admin): the web dialog's options — a
// personal note, attached files and the customer job report — over the same
// routes, with the user's Bearer token (callerClient on the server).
//
// ONLINE ONLY, on purpose: an invoice email that sat queued without signal
// would reach the customer late and silently, and the office needs to see
// "emailed to …" (or why not) while they are looking at it. Not the outbox.
//
// The server is the authority on everything here. The checks below only make
// the phone say no before the request goes, with the server's own sentences.

const API_BASE_URL = process.env.EXPO_PUBLIC_API_BASE_URL;

/** Same values as lib/job-report.ts (pinned by tests/unit/invoice-attachments-mirror.test.ts). */
export const MAX_REPORT_NOTES_CHARS = 20_000;
export const MAX_REPORT_PHOTOS = 40;

/** The send route can take a minute when it builds a report (maxDuration 60). */
const SEND_TIMEOUT_MS = 90_000;

export const INVOICE_SEND_OFFLINE = "Sending an invoice needs signal. Try again when you have it.";

/** GET /api/invoices/[id]/job-report — the shape of lib/job-report-data.ts JobReportDraft. */
export interface JobReportDraft {
  jobNumber: number | null;
  jobTitle: string | null;
  defaultNotes: string;
  visits: { date: string; label: string; names: string[] }[];
  photos: { id: string; caption: string | null; createdAt: string; thumbUrl: string | null }[];
  unsupportedPhotos: number;
  signature: { signerName: string | null; createdAt: string; url: string | null } | null;
}

/** The `jobReport` body of the send / preview routes (lib/job-report.ts JobReportRequest). */
export interface JobReportRequest {
  notes: string;
  photoIds: string[];
  includeSignature: boolean;
}

export interface SendInvoiceResult {
  success: true;
  sentTo: string;
  jobReportAttached?: boolean;
  attachmentCount?: number;
  statusUpdated?: boolean;
  warning?: string;
  reportNotice?: string | null;
}

/** The send route's 409 for hours on the job not yet on the invoice — the office may confirm and send. */
export class UnpricedHoursError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnpricedHoursError";
  }
}

async function authed(path: string, init: RequestInit, timeoutMs?: number): Promise<Response> {
  if (!API_BASE_URL) throw new Error("App isn't configured to reach the office server.");
  const { data: sessionData } = await supabase.auth.getSession();
  const accessToken = sessionData.session?.access_token;
  if (!accessToken) throw new Error("Your session has expired. Sign out and back in, then try again.");
  try {
    return await fetchWithTimeout(
      `${API_BASE_URL}${path}`,
      { ...init, headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` } },
      timeoutMs
    );
  } catch {
    throw new Error(`No connection. ${INVOICE_SEND_OFFLINE}`);
  }
}

const base = (invoiceId: string) => `/api/invoices/${encodeURIComponent(invoiceId)}`;

export async function loadJobReportDraft(invoiceId: string): Promise<JobReportDraft> {
  const res = await authed(`${base(invoiceId)}/job-report`, {});
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? "Could not load the job report.");
  return data as JobReportDraft;
}

/** Base64 of a fetched body, without the data: prefix. FileReader is RN's dependable path from a Blob. */
async function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("The file could not be read."));
    reader.onload = () => {
      const result = String(reader.result ?? "");
      resolve(result.slice(result.indexOf(",") + 1));
    };
    reader.readAsDataURL(blob);
  });
}

/** "Preview report": the PDF the send would attach, as base64, plus any note about photos left out. */
export async function previewJobReport(
  invoiceId: string,
  selection: JobReportRequest
): Promise<{ base64: string; notice: string | null }> {
  const res = await authed(`${base(invoiceId)}/job-report/preview`, { method: "POST", body: JSON.stringify(selection) }, SEND_TIMEOUT_MS);
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error ?? "The job report could not be made.");
  }
  const raw = res.headers.get("X-Report-Notice");
  let notice: string | null = null;
  if (raw) {
    try {
      notice = decodeURIComponent(raw);
    } catch {
      notice = raw;
    }
  }
  return { base64: await blobToBase64(await res.blob()), notice };
}

/** Saves a preview into the app cache (overwriting the last one) and returns its file:// uri. */
export async function writePreviewFile(invoiceNumber: number | string, base64: string): Promise<string> {
  const uri = `${FileSystem.cacheDirectory}job-report-${String(invoiceNumber).replace(/[^\w-]/g, "")}.pdf`;
  await FileSystem.writeAsStringAsync(uri, base64, { encoding: FileSystem.EncodingType.Base64 });
  return uri;
}

/** Downloads a file (a signed Storage URL) as base64 — for a job document attached to the email. */
export async function downloadAsBase64(url: string): Promise<string> {
  let res: Response;
  try {
    res = await fetchWithTimeout(url, {});
  } catch {
    throw new Error(`No connection. ${INVOICE_SEND_OFFLINE}`);
  }
  if (!res.ok) throw new Error("The document could not be downloaded. Try again.");
  return blobToBase64(await res.blob());
}

export interface SendInvoiceInput {
  to: string;
  message: string;
  jobReport: JobReportRequest | null;
  attachments: ExtraAttachment[];
  confirmUnpriced?: boolean;
}

/** The send route's body — the same keys the web dialog sends; report and files only when there are any. */
export function buildSendBody(input: SendInvoiceInput): Record<string, unknown> {
  return {
    to: input.to.trim(),
    message: input.message,
    ...(input.jobReport ? { jobReport: input.jobReport } : {}),
    ...(input.attachments.length ? { attachments: input.attachments } : {}),
    confirmUnpriced: input.confirmUnpriced === true,
  };
}

export async function sendInvoice(invoiceId: string, input: SendInvoiceInput): Promise<SendInvoiceResult> {
  const res = await authed(`${base(invoiceId)}/send`, { method: "POST", body: JSON.stringify(buildSendBody(input)) }, SEND_TIMEOUT_MS);
  const data = await res.json().catch(() => ({}));
  if (res.status === 409 && data?.code === "unpriced_hours" && !input.confirmUnpriced) {
    throw new UnpricedHoursError(data.error ?? "Some hours on this job aren't on this invoice yet.");
  }
  if (!res.ok) throw new Error(data.error ?? `Server returned ${res.status}. Try again.`);
  return data as SendInvoiceResult;
}

/** The names the invoice PDF and job report go out under — attached files can't take them. */
export function reservedAttachmentNames(invoiceNumber: number | string): string[] {
  return [`invoice-${invoiceNumber}.pdf`, `job-report-${invoiceNumber}.pdf`];
}

/** The draft's selection in report order (not the order they were ticked), as the web panel sends it. */
export function buildReportSelection(
  draft: JobReportDraft,
  notes: string,
  selected: ReadonlySet<string>,
  includeSignature: boolean
): JobReportRequest {
  return {
    notes,
    photoIds: draft.photos.filter((p) => selected.has(p.id)).map((p) => p.id),
    includeSignature: includeSignature && !!draft.signature,
  };
}

/**
 * What stops the send before it goes, in the web dialog's words, or null.
 * Attachments run through the same check the server applies.
 */
export function sendProblem(o: {
  to: string;
  includeReport: boolean;
  report: JobReportRequest | null;
  attachments: ExtraAttachment[];
  invoiceNumber: number | string;
}): string | null {
  if (!o.to.trim()) return "Enter an email address to send to";
  if (o.includeReport && !o.report) return "The job report hasn't loaded yet — wait for it, or untick it";
  if (o.report && o.report.notes.length > MAX_REPORT_NOTES_CHARS) {
    return `The job report notes are too long (at most ${MAX_REPORT_NOTES_CHARS.toLocaleString("en-AU")} characters).`;
  }
  const parsed = parseExtraAttachments(o.attachments, reservedAttachmentNames(o.invoiceNumber));
  return parsed.ok ? null : parsed.error;
}

/** The success line: "Invoice and job report and 2 attached files emailed to …". */
export function sentMessage(r: Pick<SendInvoiceResult, "sentTo" | "jobReportAttached" | "attachmentCount">): string {
  const extras = [
    r.jobReportAttached ? "job report" : null,
    r.attachmentCount ? `${r.attachmentCount} attached file${r.attachmentCount === 1 ? "" : "s"}` : null,
  ].filter(Boolean);
  return `Invoice${extras.length ? ` and ${extras.join(" and ")}` : ""} emailed to ${r.sentTo}`;
}

// ── Attachments ────────────────────────────────────────────────────────────

/** A file on the Send screen: its name, base64 body and decoded size. */
export interface PhoneAttachment extends ExtraAttachment {
  id: string;
  bytes: number;
}

const EXTENSIONS = ATTACHMENT_ACCEPT.split(",").filter((s) => s.startsWith("."));

/** Whether a file of this name may be attached (the server's extension list). */
export function isAttachableName(name: string): boolean {
  const lower = name.toLowerCase();
  return EXTENSIONS.some((ext) => lower.endsWith(ext));
}

export function attachmentsTotal(list: Pick<PhoneAttachment, "bytes">[]): number {
  return list.reduce((s, a) => s + a.bytes, 0);
}

/**
 * Add one file, held to the web field's rules: an allowed type, at most
 * MAX_ATTACHMENTS, and the total under MAX_ATTACHMENT_TOTAL_BYTES. The
 * refusal sentences are the web field's.
 */
export function addAttachment(
  list: PhoneAttachment[],
  file: PhoneAttachment
): { ok: true; list: PhoneAttachment[] } | { ok: false; error: string } {
  if (!isAttachableName(file.filename)) return { ok: false, error: `${file.filename} can't be attached (${ATTACHMENT_HINT})` };
  if (list.length >= MAX_ATTACHMENTS) return { ok: false, error: `At most ${MAX_ATTACHMENTS} files can be attached` };
  if (attachmentsTotal(list) + file.bytes > MAX_ATTACHMENT_TOTAL_BYTES) {
    return {
      ok: false,
      error: `${file.filename} (${formatBytes(file.bytes)}) would take the attachments over ${formatBytes(MAX_ATTACHMENT_TOTAL_BYTES)}`,
    };
  }
  return { ok: true, list: [...list, file] };
}

/**
 * The name a picked photo is attached under. It has been re-encoded as JPEG
 * (lib/imageUpload.ts), so the extension is always .jpg; a picker that gives
 * no name (the camera, some Android galleries) gets "photo-<n>.jpg".
 */
export function photoAttachmentName(fileName: string | null | undefined, n: number): string {
  const clean = cleanAttachmentName(fileName ?? "");
  const stem = clean.replace(/\.[^.]*$/, "").trim();
  return `${stem || `photo-${n}`}.jpg`;
}

export { formatBytes, MAX_ATTACHMENTS, MAX_ATTACHMENT_TOTAL_BYTES, ATTACHMENT_HINT };
