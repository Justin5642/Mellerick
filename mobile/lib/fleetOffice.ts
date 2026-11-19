import { supabase } from "./supabase";
import { fetchWithTimeout } from "./fetchWithTimeout";
import type { ServiceRecord } from "./serviceDue";
import { DEFAULT_SERVICE_TYPE, type ServiceFormFields, type ServiceInvoiceReadResult } from "./serviceInvoiceForm";
import { HIRE_UNITS_BY_TYPE, type HireType, type HireUnit } from "./hireLabels";

// Fleet office/admin features on the phone, calling the web's routes with the
// user's Bearer token (app/api/fleet/**). Online only, like supplier POs and
// Day Works: the service history, hire rates and attachments are office-only
// tables in no PowerSync stream, and a service's invoice is read by the server
// the moment it is picked. Every write runs as the caller on the server
// (callerClient), so RLS decides exactly as it does for the web.
//
// Money: every amount here is shown through MoneyText inside a RoleGate on the
// screens; the routes are office/admin only, so a technician never gets one.

const API_BASE_URL = process.env.EXPO_PUBLIC_API_BASE_URL;

export const FLEET_OFFLINE = "No connection. This needs signal — try again when you have it.";

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  if (!API_BASE_URL) throw new Error("App isn't configured to reach the office server.");
  const { data: sessionData } = await supabase.auth.getSession();
  const accessToken = sessionData.session?.access_token;
  if (!accessToken) throw new Error("Your session has expired. Sign out and back in, then try again.");
  let res: Response;
  try {
    res = await fetchWithTimeout(`${API_BASE_URL}${path}`, {
      ...init,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
    });
  } catch {
    throw new Error(FLEET_OFFLINE);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `Server returned ${res.status}. Try again.`);
  return data as T;
}

// ---------------------------------------------------------------------------
// Service history
// ---------------------------------------------------------------------------

export interface ServiceExpense {
  id: string;
  category: string;
  supplier_name: string | null;
  invoice_number: string | null;
  expense_date: string;
  amount: number | string;
  gst_amount: number | string | null;
  receipt_storage_path: string | null;
}

export interface ServiceHistory {
  /** false = service records aren't switched on in this database (0099). */
  ready: boolean;
  records: ServiceRecord[];
  expenses: ServiceExpense[];
}

export const loadServiceHistory = (equipmentId: string) => call<ServiceHistory>(`/api/fleet/${equipmentId}/service-records`);

export const deleteServiceRecord = (equipmentId: string, recordId: string) =>
  call<{ deleted: true }>(`/api/fleet/${equipmentId}/service-records/${recordId}`, { method: "DELETE" });

/** Read a service invoice photo (base64 JPEG/PNG/WebP/PDF) — fills the form, saves nothing. */
export const readServiceInvoice = (fileBase64: string) =>
  call<{ read: ServiceInvoiceReadResult }>(`/api/fleet/service-invoice/read`, { method: "POST", body: JSON.stringify({ fileBase64 }) });

export const NEW_EXPENSE = "__new__";
export const NO_EXPENSE = "";

/** The "Log a service" form (same fields as the web's). */
export type ServiceForm = ServiceFormFields;

export function blankServiceForm(today: string): ServiceForm {
  return {
    service_date: today,
    service_type: DEFAULT_SERVICE_TYPE,
    odometer_km: "",
    engine_hours: "",
    provider: "",
    work_done: "",
    next_due_date: "",
    next_due_km: "",
    next_due_hours: "",
    expense: NO_EXPENSE,
    amount: "",
    gst_amount: "",
    invoice_number: "",
  };
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const num = (v: string) => (v.trim() === "" ? null : Number(v));

/** The web form's checks, so the office hears before tapping Save. First problem wins. */
export function serviceFormProblem(form: ServiceForm): string | null {
  if (!DATE.test(form.service_date)) return "Enter the service date (YYYY-MM-DD).";
  for (const f of ["odometer_km", "engine_hours", "next_due_km", "next_due_hours"] as const) {
    const v = num(form[f]);
    if (v !== null && (!Number.isFinite(v) || v < 0)) return "Readings must be numbers, zero or more.";
  }
  if (form.next_due_date) {
    if (!DATE.test(form.next_due_date)) return "Check the next service date (YYYY-MM-DD).";
    if (form.next_due_date <= form.service_date) return "The next service date must be after the service date.";
  }
  const km = num(form.odometer_km);
  const dueKm = num(form.next_due_km);
  if (km !== null && dueKm !== null && dueKm <= km) return "The next service odometer must be above this service's odometer.";
  if (form.expense === NEW_EXPENSE && !(Number(form.amount) > 0)) return "Enter the amount ex GST.";
  return null;
}

/** What POST /api/fleet/[id]/service-records takes. The invoice goes only with a new cost. */
export function servicePayload(
  form: ServiceForm,
  id: string,
  invoice: { fileBase64: string; fileName: string } | null,
): Record<string, unknown> {
  const isNew = form.expense === NEW_EXPENSE;
  return {
    id,
    service_date: form.service_date,
    service_type: form.service_type,
    odometer_km: form.odometer_km,
    engine_hours: form.engine_hours,
    provider: form.provider,
    work_done: form.work_done,
    next_due_date: form.next_due_date || null,
    next_due_km: form.next_due_km,
    next_due_hours: form.next_due_hours,
    expense: isNew ? "new" : form.expense || "none",
    ...(isNew ? { amount: form.amount, gst_amount: form.gst_amount, invoice_number: form.invoice_number } : {}),
    ...(isNew && invoice ? { invoice } : {}),
  };
}

export const saveServiceRecord = (equipmentId: string, payload: Record<string, unknown>) =>
  call<{ record: ServiceRecord; expense: ServiceExpense | null; replay?: boolean }>(`/api/fleet/${equipmentId}/service-records`, {
    method: "POST",
    body: JSON.stringify(payload),
  });

/** The note shown after an invoice read — the web's wording. */
export function readNoteFor(read: ServiceInvoiceReadResult): { tone: "ok" | "warn"; text: string } {
  const foundAnything = [read.provider, read.invoice_number, read.service_date, read.amount_ex_gst, read.odometer_km, read.engine_hours, read.work_done].some((v) => v !== null);
  const parts: string[] = [];
  if (!read.is_service_invoice) parts.push("This doesn't look like a service invoice — check it's the right file.");
  if (read.vehicle_text) parts.push(`Invoice is for: ${read.vehicle_text} — check it's this machine.`);
  parts.push(foundAnything ? "Details read from the invoice — check them, then save." : "Nothing new was read from the invoice.");
  return { tone: read.is_service_invoice ? "ok" : "warn", text: parts.join(" ") };
}

/** Read-route limit (lib/service-invoice-read.ts MAX_SERVICE_INVOICE_BYTES). */
export const MAX_UPLOAD_BYTES = 3 * 1024 * 1024;
/** Bytes a base64 string decodes to. */
export const base64Bytes = (b64: string) => Math.floor((b64.length * 3) / 4) - (b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0);

// ---------------------------------------------------------------------------
// Hire setup, hire rates, attachments (0108 / 0111)
// ---------------------------------------------------------------------------

export interface HireOptionRow {
  id: string;
  equipment_id: string;
  hire_type: HireType;
  hire_unit: HireUnit;
  rate: number | string;
  fuel_included: boolean;
  whole_days_only: boolean;
  float_base: number | string;
  float_km_included: number | string;
  float_per_km: number | string;
  cost_centre_id: string | null;
  is_active: boolean;
  notes: string | null;
}

export interface HireSetup {
  ready: boolean;
  machine?: { id: string; name: string; category: string | null };
  options: HireOptionRow[];
  costCentres: { id: string; name: string }[];
}

export const loadHireSetup = (equipmentId: string) => call<HireSetup>(`/api/fleet/${equipmentId}/hire-options`);

export interface HireFormRow {
  key: string;
  hire_type: HireType;
  hire_unit: HireUnit;
  rate: string;
  fuel_included: boolean;
  whole_days_only: boolean;
  float_base: string;
  float_km_included: string;
  float_per_km: string;
  cost_centre_id: string;
  is_active: boolean;
  notes: string;
}

export const hireFormRow = (o: HireOptionRow): HireFormRow => ({
  key: o.id,
  hire_type: o.hire_type,
  hire_unit: o.hire_unit,
  rate: String(o.rate ?? 0),
  fuel_included: o.fuel_included,
  whole_days_only: o.whole_days_only,
  float_base: String(o.float_base ?? 0),
  float_km_included: String(o.float_km_included ?? 0),
  float_per_km: String(o.float_per_km ?? 0),
  cost_centre_id: o.cost_centre_id ?? "",
  is_active: o.is_active,
  notes: o.notes ?? "",
});

export const blankHireRow = (key: string): HireFormRow => ({
  key, hire_type: "wet", hire_unit: "hour", rate: "", fuel_included: true, whole_days_only: false,
  float_base: "", float_km_included: "30", float_per_km: "", cost_centre_id: "", is_active: true, notes: "",
});

/** Changing the hire type resets the unit to that type's first, as the web does. */
export function withHireType(row: HireFormRow, t: HireType): HireFormRow {
  return { ...row, hire_type: t, hire_unit: HIRE_UNITS_BY_TYPE[t][0] };
}

/** The web dialog's checks. */
export function hireSetupProblem(rows: HireFormRow[]): string | null {
  const keys = rows.map((r) => `${r.hire_type}|${r.hire_unit}`);
  if (new Set(keys).size !== keys.length) return "Each way of hiring can only be listed once per machine.";
  for (const r of rows) {
    if (!HIRE_UNITS_BY_TYPE[r.hire_type].includes(r.hire_unit)) return "Pick how the machine is hired and charged.";
    for (const v of [r.rate, r.float_base, r.float_km_included, r.float_per_km]) {
      if (v.trim() !== "" && (!Number.isFinite(Number(v)) || Number(v) < 0)) return "Rates can't be negative or blank text.";
    }
  }
  return null;
}

/** A form row as the route takes it (the local key stays on the phone). */
export function hireRowPayload(r: HireFormRow): Omit<HireFormRow, "key"> {
  return {
    hire_type: r.hire_type, hire_unit: r.hire_unit, rate: r.rate, fuel_included: r.fuel_included,
    whole_days_only: r.whole_days_only, float_base: r.float_base, float_km_included: r.float_km_included,
    float_per_km: r.float_per_km, cost_centre_id: r.cost_centre_id, is_active: r.is_active, notes: r.notes,
  };
}

export const saveHireSetup =(equipmentId: string, rows: HireFormRow[]) =>
  call<HireSetup>(`/api/fleet/${equipmentId}/hire-options`, {
    method: "PUT",
    body: JSON.stringify({ options: rows.map(hireRowPayload) }),
  });

export interface HireRateRow {
  id: string;
  name: string;
  category: string | null;
  options: { label: string; rateText: string; active: boolean }[];
  hasRate: boolean;
}

export interface HireAttachment {
  id: string;
  name: string;
  day_rate: number | string;
  is_active: boolean;
  notes: string | null;
}

export interface HireRates {
  ready: boolean;
  rows: HireRateRow[];
  missing: number;
  attachments: HireAttachment[];
}

export const loadHireRates = () => call<HireRates>(`/api/fleet/hire-rates`);

export const addHireAttachment = (name: string, dayRate: string) =>
  call<{ attachment: HireAttachment }>(`/api/fleet/hire-attachments`, { method: "POST", body: JSON.stringify({ name, day_rate: dayRate }) });

export const updateHireAttachment = (id: string, patch: { day_rate?: number; is_active?: boolean }) =>
  call<{ attachment: HireAttachment }>(`/api/fleet/hire-attachments/${id}`, { method: "PATCH", body: JSON.stringify(patch) });

// ---------------------------------------------------------------------------
// Equipment documents
// ---------------------------------------------------------------------------

export const uploadEquipmentDocument = (equipmentId: string, fileBase64: string, fileName: string) =>
  call<{ document: { id: string } }>(`/api/fleet/${equipmentId}/documents`, { method: "POST", body: JSON.stringify({ fileBase64, fileName }) });
