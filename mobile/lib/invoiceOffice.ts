import { supabase } from "./supabase";
import { fetchWithTimeout } from "./fetchWithTimeout";
import type { PaymentInput } from "./invoicePayments";

// Office/admin invoice and quote actions on the phone — the web invoice
// page's buttons over the SAME web routes, with the user's Bearer token
// (callerClient on the server, so RLS runs as them):
//   PDF            GET    /api/invoices/[id]/pdf, /api/quotes/[id]/pdf
//   Xero           POST   /api/xero/push-invoice            (admin)
//   Payments       GET/POST /api/invoices/[id]/payments, DELETE …/payments/[paymentId]
//   Delete         DELETE /api/invoices/[id]                (office/admin)
//   Job hours      GET/POST /api/invoices/[id]/hours
//   Send a quote   POST   /api/quotes/[id]/send
//
// ONLINE ONLY, on purpose: each of these either talks to Xero / the email
// provider / the PDF renderer, or changes money the office is looking at
// (payments are not in the phone's mirror — invoice_payments is in no stream),
// so the answer has to come back while they wait. Not the outbox.
//
// The server is the authority on everything; errors shown are its sentences.

const API_BASE_URL = process.env.EXPO_PUBLIC_API_BASE_URL;

export const OFFICE_ACTION_OFFLINE = "This needs signal. Try again when you have it.";

/** Xero, the email and the PDF renderer can each take a while (the routes cap at 30 s). */
const SLOW_TIMEOUT_MS = 45_000;

async function call(path: string, init: RequestInit = {}, timeoutMs?: number): Promise<Response> {
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
    throw new Error(`No connection. ${OFFICE_ACTION_OFFLINE}`);
  }
}

async function json<T>(res: Response, fallback: string): Promise<T> {
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(data?.error ?? fallback, res.status, data?.code);
  return data as T;
}

/** A refusal from a route: its sentence, status and (when given) its code. */
export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) {
    super(message);
    this.name = "ApiError";
  }
}

const invoicePath = (id: string) => `/api/invoices/${encodeURIComponent(id)}`;
const quotePath = (id: string) => `/api/quotes/${encodeURIComponent(id)}`;

// ── PDF ────────────────────────────────────────────────────────────────────

/** Base64 of a fetched body, without the data: prefix. */
async function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("The PDF could not be read."));
    reader.onload = () => {
      const result = String(reader.result ?? "");
      resolve(result.slice(result.indexOf(",") + 1));
    };
    reader.readAsDataURL(blob);
  });
}

/** The invoice or quote PDF, exactly as it would be emailed, as base64. */
export async function fetchDocumentPdf(kind: "invoice" | "quote", id: string): Promise<string> {
  const res = await call(`${kind === "invoice" ? invoicePath(id) : quotePath(id)}/pdf`, {}, SLOW_TIMEOUT_MS);
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data?.error ?? `The ${kind} PDF could not be made. Try again.`);
  }
  return blobToBase64(await res.blob());
}

/** The file name a document's PDF is saved under in the app cache. */
export function pdfFileName(kind: "invoice" | "quote", number: number | string): string {
  return `${kind}-${String(number).replace(/[^\w-]/g, "")}.pdf`;
}

// ── Xero ───────────────────────────────────────────────────────────────────

/** Push (or update) the invoice in Xero. Admin only on the server. A 409 code "unpriced_hours" asks first. */
export async function pushInvoiceToXero(invoiceId: string, confirmUnpriced: boolean): Promise<{ updated: boolean }> {
  const res = await call(`/api/xero/push-invoice`, { method: "POST", body: JSON.stringify({ invoiceId, confirmUnpriced }) }, SLOW_TIMEOUT_MS);
  const data = await json<{ updated?: boolean }>(res, "Failed to push to Xero");
  return { updated: !!data.updated };
}

// ── Payments ───────────────────────────────────────────────────────────────

export interface InvoicePaymentRow {
  id: string;
  amount: number;
  paid_on: string;
  method: string;
  reference: string | null;
}

export interface InvoicePaymentsState {
  invoice: { id: string; status: string; total: number | null; amount_paid: number | null; xero_invoice_id: string | null; balance: number };
  /** null when the database has no invoice_payments table yet (0081). */
  payments: InvoicePaymentRow[] | null;
  xeroConnected: boolean;
}

export async function loadInvoicePayments(invoiceId: string): Promise<InvoicePaymentsState> {
  return json(await call(`${invoicePath(invoiceId)}/payments`), "The payments could not be loaded. Try again.");
}

export async function recordInvoicePayment(invoiceId: string, payment: PaymentInput): Promise<{ status: string | null; balance: number | null }> {
  return json(
    await call(`${invoicePath(invoiceId)}/payments`, { method: "POST", body: JSON.stringify(payment) }),
    "The payment could not be saved. Please try again."
  );
}

export async function removeInvoicePayment(invoiceId: string, paymentId: string): Promise<void> {
  await json(
    await call(`${invoicePath(invoiceId)}/payments/${encodeURIComponent(paymentId)}`, { method: "DELETE" }),
    "That payment could not be removed."
  );
}

// ── Delete ─────────────────────────────────────────────────────────────────

export async function deleteInvoice(invoiceId: string): Promise<{ inXero: boolean }> {
  const data = await json<{ inXero?: boolean }>(
    await call(invoicePath(invoiceId), { method: "DELETE" }),
    "The invoice could not be deleted. Please try again."
  );
  return { inXero: !!data.inXero };
}

// ── Job hours on the invoice ───────────────────────────────────────────────

export type RateMode = "all" | "technician" | "cost_centre";
export type RateSource = "quote" | "charge_out" | "company";

/** GET /api/invoices/[id]/hours — lib/invoice-hours.ts InvoiceHoursView. */
export interface InvoiceHoursView {
  invoiceId: string;
  jobId: string | null;
  groups: {
    key: string;
    costCentreKey: string;
    costCentreName: string | null;
    staffId: string;
    staffName: string;
    hours: number;
    billedHere: boolean;
  }[];
  unbilledHours: number;
  billedHereHours: number;
  billedElsewhereHours: number;
  defaults: {
    all: number;
    allSource: RateSource;
    byStaff: Record<string, { rate: number; source: RateSource }>;
    byCostCentre: Record<string, { rate: number; source: RateSource }>;
  } | null;
  locked: boolean;
  outside: "xero" | "sent" | null;
}

/** Same key as lib/approved-hours.ts NO_COST_CENTRE. */
export const NO_COST_CENTRE = "none";

export async function loadInvoiceHours(invoiceId: string): Promise<InvoiceHoursView> {
  return json(await call(`${invoicePath(invoiceId)}/hours`), "Could not load the job's hours");
}

export interface ApplyHoursBody {
  mode: RateMode;
  all: string;
  byStaff: Record<string, string>;
  byCostCentre: Record<string, string>;
  confirmOutside: boolean;
}

export async function applyInvoiceHours(
  invoiceId: string,
  body: ApplyHoursBody
): Promise<{ lines: number; hours: number; total: number }> {
  return json(
    await call(`${invoicePath(invoiceId)}/hours`, { method: "POST", body: JSON.stringify(body) }),
    "The hours could not be applied"
  );
}

/**
 * "12.50h billed on 2 lines." The web's toast adds the new total; on the phone
 * the total is shown by the screen itself (MoneyText), never in an alert.
 */
export function hoursAppliedMessage(r: { lines: number; hours: number }): string {
  return `${r.hours.toFixed(2)}h billed on ${r.lines} line${r.lines === 1 ? "" : "s"}.`;
}

// ── Quotes ─────────────────────────────────────────────────────────────────

export async function sendQuote(quoteId: string, to: string, message: string): Promise<{ sentTo: string }> {
  return json(
    await call(`${quotePath(quoteId)}/send`, { method: "POST", body: JSON.stringify({ to: to.trim(), message }) }, SLOW_TIMEOUT_MS),
    "Failed to send quote"
  );
}
