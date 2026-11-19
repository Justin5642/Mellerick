import { fetchWithTimeout } from "./fetchWithTimeout";
import { supabase } from "./supabase";
import type { BuilderPoLineInput, CostCentreOption } from "./builderPo";

// The job's Purchase Orders tab for the office on the phone (Nov 2026) — the
// web PO tab (components/job/job-po.tsx): the builder's POs split by cost
// centre, the supplier orders under each line, their invoices and Xero bills.
//
// ONLINE ONLY, through the web API (app/api/jobs/[id]/purchase-orders/**,
// .../supplier-orders/[orderId]/**, /api/xero/push-vendor-order), every route
// requireOfficeOrAdmin and run as the caller: supplier orders are in no
// PowerSync stream, a supplier invoice becomes a Xero bill, and a PO's value
// is what the job is measured against — none of that should sit queued. The
// answers carry money, so the screen renders every figure through MoneyText.

export const PO_TAB_OFFLINE = "Purchase orders need signal. Try again when you have it.";
export const DOCUMENTS_OFFLINE = "Uploading documents needs signal. Try again when you have it.";

export interface PoLine {
  id: string;
  name: string;
  cost_centre_id: string | null;
  allocated_amount: number;
  allocated_hours: number;
  sort_order: number;
  completed_at: string | null;
}

export interface JobPo {
  id: string;
  po_number: string;
  client_reference: string | null;
  site_address: string | null;
  site_lat: number | null;
  site_lng: number | null;
  total_value: number;
  total_hours: number;
  lines: PoLine[];
}

export type OrderStatus = "ordered" | "received" | "cancelled";

export interface PoSupplierOrder {
  id: string;
  cost_center_id: string;
  po_number: string;
  vendor_name: string;
  order_number: string | null;
  description: string | null;
  amount: number;
  gst_amount: number;
  status: OrderStatus;
  order_date: string | null;
  notes: string | null;
  delivered_at: string | null;
  invoice_number: string | null;
  invoice_date: string | null;
  invoice_storage_path: string | null;
  xero_bill_id: string | null;
  created_at: string | null;
  raised_by: string | null;
  items: { description: string; quantity: number }[];
}

export interface JobPurchaseOrdersState {
  job: { id: string; jobNumber: number | null; title: string | null };
  defaults: { poNumber: string; clientReference: string; siteAddress: string };
  costCentres: CostCentreOption[];
  pos: JobPo[];
  orders: PoSupplierOrder[];
  hoursByLine: Record<string, number>;
  spentByLine: Record<string, number>;
  inUse: Record<string, string>;
  invoicedPos: Record<string, string>;
  /** A saved-but-check-it message (part not split, a partial save). */
  warning?: string;
}

export interface PoFormInput {
  poNumber: string;
  clientReference: string;
  siteAddress: string;
  value: string;
  lines: BuilderPoLineInput[];
}

export interface SupplierInvoiceInput {
  invoiceNumber: string;
  invoiceDate: string | null;
  amount: string;
  /** base64 JPEG from lib/imageUpload.ts prepareImage, or none (keeps any file already attached). */
  file?: string | null;
  fileName?: string;
}

const API_BASE_URL = process.env.EXPO_PUBLIC_API_BASE_URL;

/** A call to the office server with the signed-in user's token. "No connection." prefixes an offline failure. */
async function officeCall<T>(path: string, init: RequestInit, offline: string, timeoutMs?: number): Promise<T> {
  if (!API_BASE_URL) throw new Error("App isn't configured to reach the office server.");
  const { data: sessionData } = await supabase.auth.getSession();
  const accessToken = sessionData.session?.access_token;
  if (!accessToken) throw new Error("Your session has expired. Sign out and back in, then try again.");
  let res: Response;
  try {
    res = await fetchWithTimeout(
      `${API_BASE_URL}${path}`,
      { ...init, headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` } },
      timeoutMs
    );
  } catch {
    throw new Error(`No connection. ${offline}`);
  }
  // A non-JSON body (a platform error page) must still surface the status.
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `Server returned ${res.status}. Try again.`);
  return data as T;
}

function call<T>(path: string, init: RequestInit = {}, timeoutMs?: number): Promise<T> {
  return officeCall<T>(path, init, PO_TAB_OFFLINE, timeoutMs);
}

function callDocuments<T>(path: string, init: RequestInit = {}, timeoutMs?: number): Promise<T> {
  return officeCall<T>(path, init, DOCUMENTS_OFFLINE, timeoutMs);
}

const enc = encodeURIComponent;
const base = (jobId: string) => `/api/jobs/${enc(jobId)}`;

export function loadJobPurchaseOrders(jobId: string): Promise<JobPurchaseOrdersState> {
  return call(`${base(jobId)}/purchase-orders`);
}

/** Safe to retry with the same `id`: the server answers a second add as saved. */
export function addJobPo(jobId: string, id: string, form: PoFormInput): Promise<JobPurchaseOrdersState> {
  return call(`${base(jobId)}/purchase-orders`, { method: "POST", body: JSON.stringify({ id, ...form }) });
}

export function editJobPo(jobId: string, poId: string, form: PoFormInput): Promise<JobPurchaseOrdersState> {
  return call(`${base(jobId)}/purchase-orders/${enc(poId)}`, { method: "PATCH", body: JSON.stringify(form) });
}

export function deleteJobPo(jobId: string, poId: string): Promise<JobPurchaseOrdersState> {
  return call(`${base(jobId)}/purchase-orders/${enc(poId)}`, { method: "DELETE" });
}

export function updateSupplierOrder(jobId: string, orderId: string, patch: { amount?: string; status?: OrderStatus }): Promise<JobPurchaseOrdersState> {
  return call(`${base(jobId)}/supplier-orders/${enc(orderId)}`, { method: "PATCH", body: JSON.stringify(patch) });
}

export function deleteSupplierOrder(jobId: string, orderId: string): Promise<JobPurchaseOrdersState> {
  return call(`${base(jobId)}/supplier-orders/${enc(orderId)}`, { method: "DELETE" });
}

export function saveSupplierInvoice(jobId: string, orderId: string, input: SupplierInvoiceInput): Promise<JobPurchaseOrdersState> {
  return call(`${base(jobId)}/supplier-orders/${enc(orderId)}/invoice`, { method: "POST", body: JSON.stringify(input) }, 60_000);
}

/** The supplier's invoice becomes an AUTHORISED bill in Xero (the web's own route). */
export function sendSupplierInvoiceToXero(orderId: string): Promise<{ xeroBillId: string }> {
  return call(`/api/xero/push-vendor-order`, { method: "POST", body: JSON.stringify({ orderId }) });
}

/** A short-lived link to the supplier invoice file (office reads job-documents under RLS). */
export async function supplierInvoiceUrl(path: string): Promise<string> {
  const { data, error } = await supabase.storage.from("job-documents").createSignedUrl(path, 300);
  if (error || !data?.signedUrl) throw new Error("Couldn't open the invoice file.");
  return data.signedUrl;
}

export function isOfflineError(e: unknown): boolean {
  return e instanceof Error && e.message.startsWith("No connection.");
}

const cents = (n: number) => Math.round(n * 100);

/** "Split" / "$x not split yet" / "$x over" — the web PO card's state. */
export function poSplitState(po: Pick<JobPo, "total_value" | "lines">): { kind: "split" | "unsplit" | "over"; amount: number } {
  const left = cents(Number(po.total_value) || 0) - po.lines.reduce((s, l) => s + cents(Number(l.allocated_amount) || 0), 0);
  if (left > 0) return { kind: "unsplit", amount: left / 100 };
  if (left < 0) return { kind: "over", amount: -left / 100 };
  return { kind: "split", amount: 0 };
}

/** The supplier orders raised against each PO line, newest first (as the server sends them). */
export function ordersByLine(orders: PoSupplierOrder[]): Record<string, PoSupplierOrder[]> {
  const out: Record<string, PoSupplierOrder[]> = {};
  for (const o of orders) (out[o.cost_center_id] ??= []).push(o);
  return out;
}

/** The invoice form's check before sending — the server applies the same. Null = fine. */
export function supplierInvoiceProblem(input: Pick<SupplierInvoiceInput, "invoiceNumber" | "amount" | "invoiceDate">): string | null {
  if (!input.invoiceNumber.trim()) return "Enter the supplier's invoice number.";
  const amount = Number(input.amount.replace(/[$,\s]/g, ""));
  if (!input.amount.trim() || !Number.isFinite(amount) || amount <= 0) return "Enter the invoice amount ex GST.";
  if (input.invoiceDate && !/^\d{4}-\d{2}-\d{2}$/.test(input.invoiceDate)) return "Enter the invoice date as YYYY-MM-DD.";
  return null;
}

/** GST at 10% of an amount typed ex GST, to the cent; null when not a number. */
export function gstOf(amount: string): number | null {
  const n = Number(amount.replace(/[$,\s]/g, ""));
  if (!amount.trim() || !Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 10) / 100;
}

// ----- job documents (office/admin) -----


/** Uploads a photo (base64 JPEG) as a job document. 60 s: it carries the file up. */
export async function uploadJobDocument(
  jobId: string,
  input: { file: string; fileName: string; officeOnly: boolean }
): Promise<{ id: string; fileName: string }> {
  return callDocuments(`${base(jobId)}/documents`, { method: "POST", body: JSON.stringify(input) }, 60_000);
}

export function setJobDocumentOfficeOnly(jobId: string, docId: string, officeOnly: boolean): Promise<{ officeOnly: boolean }> {
  return callDocuments(`${base(jobId)}/documents/${enc(docId)}`, { method: "PATCH", body: JSON.stringify({ officeOnly }) });
}

export function deleteJobDocument(jobId: string, docId: string): Promise<{ deleted: boolean; warning?: string }> {
  return callDocuments(`${base(jobId)}/documents/${enc(docId)}`, { method: "DELETE" });
}

/** "Site photo 19 Nov 2026.jpg" — a name for a document photographed on the phone. */
export function documentPhotoName(label: string, now = new Date()): string {
  const cleaned = label.trim().replace(/[^a-zA-Z0-9 ._-]/g, "").slice(0, 60).trim();
  const day = now.toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric", timeZone: "Australia/Melbourne" });
  return `${cleaned || `Photo ${day}`}.jpg`;
}
