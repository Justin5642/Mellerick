// Fleet office/admin writes the phone makes through API routes (web routes
// under app/api/fleet/**): log a service with its invoice, hire setup per
// machine, hire attachments, equipment documents. Pure — the routes call these
// to check what they were sent, then write as the CALLER (callerClient), so
// 0099/0108/0047's RLS decide exactly as they do for the web's own writes.
//
// Every refusal is a fixed sentence written for the office. Database text is
// logged on the server, never returned.

import { SERVICE_TYPE_EXPENSE_CATEGORY, SERVICE_TYPE_LABELS } from "@/lib/service-due";
import { HIRE_TYPE_LABELS, isValidHireUnit, type HireType, type HireUnit } from "@/lib/hire-pricing";

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export const isUuid = (v: unknown): v is string => typeof v === "string" && UUID.test(v);

const text = (v: unknown, max = 2000): string | null => {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t === "" ? null : t.slice(0, max);
};

/** "" / null / undefined → null; anything else must be a finite number ≥ 0. */
function optionalNumber(v: unknown): number | null | "bad" {
  if (v === null || v === undefined || (typeof v === "string" && v.trim() === "")) return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) && n >= 0 ? n : "bad";
}

function validDate(v: unknown): string | null {
  if (typeof v !== "string" || !DATE.test(v)) return null;
  const t = Date.parse(`${v}T00:00:00Z`);
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === v ? v : null;
}

/** A safe storage file name (same rule as the web's uploads). */
export function safeFileName(name: unknown, fallback: string): string {
  const n = typeof name === "string" && name.trim() !== "" ? name.trim() : fallback;
  return n.replace(/[^a-zA-Z0-9._-]/g, "_").slice(-120);
}

// ---------------------------------------------------------------------------
// Log a service (equipment_service_records, 0099) — the web's "Log a service"
// ---------------------------------------------------------------------------

export interface ServiceRecordWrite {
  /** Client-made id, so a retry after a dropped connection doesn't log it twice. */
  id: string | null;
  record: {
    service_date: string;
    service_type: string;
    odometer_km: number | null;
    engine_hours: number | null;
    provider: string | null;
    work_done: string | null;
    next_due_date: string | null;
    next_due_km: number | null;
    next_due_hours: number | null;
  };
  /** none = no cost; new = log the cost now; otherwise an existing expense's id. */
  expense: { kind: "none" } | { kind: "existing"; id: string } | { kind: "new"; amount: number; gst_amount: number; invoice_number: string | null };
  /** The invoice copy (base64), only with a new cost. */
  invoice: { base64: string; fileName: string } | null;
}

export function parseServiceRecordBody(body: unknown): Parsed<ServiceRecordWrite> {
  const b = (body ?? {}) as Record<string, unknown>;
  const fail = (error: string): Parsed<ServiceRecordWrite> => ({ ok: false, error });

  const service_date = validDate(b.service_date);
  if (!service_date) return fail("Enter the service date.");
  const service_type = typeof b.service_type === "string" && b.service_type in SERVICE_TYPE_LABELS ? b.service_type : null;
  if (!service_type) return fail("Pick the type of service.");

  const nums: Record<"odometer_km" | "engine_hours" | "next_due_km" | "next_due_hours", number | null> = {
    odometer_km: null, engine_hours: null, next_due_km: null, next_due_hours: null,
  };
  for (const k of Object.keys(nums) as (keyof typeof nums)[]) {
    const v = optionalNumber(b[k]);
    if (v === "bad") return fail("Readings must be numbers, zero or more.");
    nums[k] = v;
  }
  let next_due_date: string | null = null;
  if (b.next_due_date !== null && b.next_due_date !== undefined && b.next_due_date !== "") {
    next_due_date = validDate(b.next_due_date);
    if (!next_due_date) return fail("Check the next service date.");
    if (next_due_date <= service_date) return fail("The next service date must be after the service date.");
  }
  if (nums.odometer_km !== null && nums.next_due_km !== null && nums.next_due_km <= nums.odometer_km) {
    return fail("The next service odometer must be above this service's odometer.");
  }

  let expense: ServiceRecordWrite["expense"] = { kind: "none" };
  if (b.expense === "new") {
    const amount = optionalNumber(b.amount);
    if (amount === "bad" || amount === null || amount <= 0) return fail("Enter the amount ex GST.");
    const gst = optionalNumber(b.gst_amount);
    if (gst === "bad") return fail("Check the GST amount.");
    expense = { kind: "new", amount, gst_amount: gst ?? 0, invoice_number: text(b.invoice_number, 100) };
  } else if (b.expense !== undefined && b.expense !== null && b.expense !== "" && b.expense !== "none") {
    if (!isUuid(b.expense)) return fail("That cost wasn't found.");
    expense = { kind: "existing", id: b.expense };
  }

  let invoice: ServiceRecordWrite["invoice"] = null;
  const inv = b.invoice as Record<string, unknown> | null | undefined;
  if (inv && typeof inv === "object") {
    if (expense.kind !== "new") return fail("An invoice copy is saved only with a new cost.");
    if (typeof inv.fileBase64 !== "string" || inv.fileBase64 === "") return fail("The invoice file was empty.");
    invoice = { base64: inv.fileBase64, fileName: safeFileName(inv.fileName, "invoice.jpg") };
  }

  if (b.id !== undefined && b.id !== null && !isUuid(b.id)) return fail("Couldn't save the service. Try again.");

  return {
    ok: true,
    value: {
      id: (b.id as string | undefined) ?? null,
      record: {
        service_date,
        service_type,
        odometer_km: nums.odometer_km,
        engine_hours: nums.engine_hours,
        provider: text(b.provider, 200),
        work_done: text(b.work_done),
        next_due_date,
        next_due_km: nums.next_due_km,
        next_due_hours: nums.next_due_hours,
      },
      expense,
      invoice,
    },
  };
}

/** The equipment_expenses row a new service cost is logged as (same as the web). */
export function serviceExpenseRow(
  equipmentId: string,
  w: ServiceRecordWrite,
  loggedBy: string,
  receiptPath: string | null,
): Record<string, unknown> | null {
  if (w.expense.kind !== "new") return null;
  return {
    equipment_id: equipmentId,
    category: SERVICE_TYPE_EXPENSE_CATEGORY[w.record.service_type] ?? "service",
    supplier_name: w.record.provider,
    description: w.record.work_done ?? SERVICE_TYPE_LABELS[w.record.service_type],
    invoice_number: w.expense.invoice_number,
    expense_date: w.record.service_date,
    amount: w.expense.amount,
    gst_amount: w.expense.gst_amount,
    receipt_storage_path: receiptPath,
    logged_by: loggedBy,
  };
}

// ---------------------------------------------------------------------------
// Hire setup per machine (equipment_hire_options, 0108/0111)
// ---------------------------------------------------------------------------

export interface HireOptionInput {
  hire_type: HireType;
  hire_unit: HireUnit;
  rate: number;
  fuel_included: boolean;
  whole_days_only: boolean;
  float_base: number;
  float_km_included: number;
  float_per_km: number;
  cost_centre_id: string | null;
  is_active: boolean;
  notes: string | null;
}

/**
 * What a hire setup save does, the web dialog's rule: saved by (machine,
 * type, unit); anything no longer listed is removed.
 */
export function planHireOptionsSave(
  equipmentId: string,
  existing: { id: string; hire_type: string; hire_unit: string }[],
  body: unknown,
): Parsed<{ deleteIds: string[]; upserts: (HireOptionInput & { equipment_id: string })[] }> {
  const list = (body as { options?: unknown } | null)?.options;
  if (!Array.isArray(list)) return { ok: false, error: "Couldn't save the hire setup. Try again." };
  if (list.length > 20) return { ok: false, error: "That's too many ways to hire one machine." };
  const upserts: (HireOptionInput & { equipment_id: string })[] = [];
  for (const raw of list) {
    const r = (raw ?? {}) as Record<string, unknown>;
    const hire_type = r.hire_type as HireType;
    const hire_unit = r.hire_unit as HireUnit;
    if (!(hire_type in HIRE_TYPE_LABELS) || !isValidHireUnit(hire_type, hire_unit)) {
      return { ok: false, error: "Pick how the machine is hired and charged." };
    }
    const n: Record<"rate" | "float_base" | "float_km_included" | "float_per_km", number> = { rate: 0, float_base: 0, float_km_included: 0, float_per_km: 0 };
    for (const k of Object.keys(n) as (keyof typeof n)[]) {
      const v = optionalNumber(r[k]);
      if (v === "bad") return { ok: false, error: "Rates can't be negative or blank text." };
      n[k] = v ?? 0;
    }
    if (r.cost_centre_id !== null && r.cost_centre_id !== undefined && r.cost_centre_id !== "" && !isUuid(r.cost_centre_id)) {
      return { ok: false, error: "Pick the cost centre again." };
    }
    const isFloat = hire_type === "float";
    upserts.push({
      equipment_id: equipmentId,
      hire_type,
      hire_unit,
      rate: isFloat ? 0 : n.rate,
      fuel_included: r.fuel_included !== false,
      whole_days_only: hire_unit === "day" && r.whole_days_only === true,
      float_base: isFloat ? n.float_base : 0,
      float_km_included: isFloat ? n.float_km_included : 0,
      float_per_km: isFloat ? n.float_per_km : 0,
      cost_centre_id: (r.cost_centre_id as string | null | undefined) || null,
      is_active: r.is_active !== false,
      notes: text(r.notes, 500),
    });
  }
  const keys = upserts.map((u) => `${u.hire_type}|${u.hire_unit}`);
  if (new Set(keys).size !== keys.length) return { ok: false, error: "Each way of hiring can only be listed once per machine." };
  const deleteIds = existing.filter((o) => !keys.includes(`${o.hire_type}|${o.hire_unit}`)).map((o) => o.id);
  return { ok: true, value: { deleteIds, upserts } };
}

// ---------------------------------------------------------------------------
// Hire attachments (hire_attachments, 0108)
// ---------------------------------------------------------------------------

export function parseNewAttachment(body: unknown): Parsed<{ name: string; day_rate: number }> {
  const b = (body ?? {}) as Record<string, unknown>;
  const name = text(b.name, 100);
  if (!name) return { ok: false, error: "Name the attachment." };
  const rate = optionalNumber(b.day_rate);
  if (rate === "bad") return { ok: false, error: "Check the day rate." };
  return { ok: true, value: { name, day_rate: rate ?? 0 } };
}

export function parseAttachmentPatch(body: unknown): Parsed<{ day_rate?: number; is_active?: boolean }> {
  const b = (body ?? {}) as Record<string, unknown>;
  const patch: { day_rate?: number; is_active?: boolean } = {};
  if (b.day_rate !== undefined) {
    const rate = optionalNumber(b.day_rate);
    if (rate === "bad" || rate === null) return { ok: false, error: "Check the day rate." };
    patch.day_rate = rate;
  }
  if (b.is_active !== undefined) {
    if (typeof b.is_active !== "boolean") return { ok: false, error: "Couldn't save the attachment." };
    patch.is_active = b.is_active;
  }
  if (Object.keys(patch).length === 0) return { ok: false, error: "Nothing to change." };
  return { ok: true, value: patch };
}

// ---------------------------------------------------------------------------
// Uploaded files (service invoices, equipment documents)
// ---------------------------------------------------------------------------

/** Request bodies travel as base64 and Vercel caps a request at 4.5 MB. */
export const MAX_FLEET_UPLOAD_BYTES = 3 * 1024 * 1024;

export type FleetUploadMime = "application/pdf" | "image/jpeg" | "image/png" | "image/webp";

/** Trust the bytes, not the claimed type: PDF, JPEG, PNG or WebP only. */
export function sniffFleetUpload(buf: Uint8Array): FleetUploadMime | null {
  const at = (i: number, ...bytes: number[]) => bytes.every((b, j) => buf[i + j] === b);
  if (at(0, 0x25, 0x50, 0x44, 0x46, 0x2d)) return "application/pdf";
  if (at(0, 0xff, 0xd8, 0xff)) return "image/jpeg";
  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return "image/webp";
  return null;
}

/** Decode and check an uploaded file. */
export function decodeFleetUpload(base64: string): Parsed<{ bytes: Buffer; mime: FleetUploadMime }> {
  const bytes = Buffer.from(base64, "base64");
  if (bytes.length === 0) return { ok: false, error: "The file was empty." };
  if (bytes.length > MAX_FLEET_UPLOAD_BYTES) return { ok: false, error: "That file is too large (over 3 MB)." };
  const mime = sniffFleetUpload(bytes);
  if (!mime) return { ok: false, error: "Only PDF, JPEG, PNG or WebP files can be uploaded." };
  return { ok: true, value: { bytes, mime } };
}

/** Where an equipment document is stored — the web's Documents tab path. */
export function equipmentDocumentPath(equipmentId: string, fileName: string, now: number): string {
  return `${equipmentId}/${now}_${safeFileName(fileName, "document")}`;
}

/** PostgREST / Postgres "this table isn't here yet". */
export function isMissingTable(error: { code?: string | null } | null | undefined): boolean {
  return !!error && ["42P01", "PGRST205", "PGRST200", "42703", "PGRST204"].includes(error.code ?? "");
}
