// One truck load as typed in (0111, drafted — not applied yet). Pure, shared by the API routes the phone
// calls (app/api/jobs/[id]/cartage-loads/...) and, for the same words, the
// phone's own early check (mobile/lib/truckLoads.ts mirrors these rules). The
// database (0111's cartage_loads_guard) is still the last word.
//
// No money here: a load is quantities only.

import { isUuid, typedNumber, type Typed } from "@/lib/day-works-entry";
import type { LoadBilling, LoadDirection, LoadUnit } from "@/lib/cartage-pricing";

export interface CartageLoadInput {
  equipment_id: string;
  load_date: string;
  direction: LoadDirection;
  material?: string | null;
  supplier_id?: string | null;
  place?: string | null;
  from_text?: string | null;
  to_text?: string | null;
  quantity?: Typed;
  unit: LoadUnit;
  km?: Typed;
  docket_number?: string | null;
  /** Null = the database's default (spoil → extra; quarry product → the job's setting). */
  billing?: LoadBilling | null;
}

/** The cartage_loads columns a load writes (job_id is the caller's to add). */
export interface CartageLoadRowFields {
  equipment_id: string;
  load_date: string;
  direction: LoadDirection;
  material: string | null;
  supplier_id: string | null;
  place: string | null;
  from_text: string | null;
  to_text: string | null;
  quantity: number | null;
  unit: LoadUnit;
  km: number | null;
  docket_number: string | null;
  billing?: LoadBilling;
}

const DIRECTIONS = new Set<string>(["material_in", "spoil_out"]);
const UNITS = new Set<string>(["tonne", "m3", "load"]);
const BILLINGS = new Set<string>(["included", "extra"]);
const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;

function realDate(key: string): boolean {
  if (!DATE_KEY.test(key)) return false;
  const [y, m, d] = key.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

const text = (v: unknown) => (typeof v === "string" ? v.trim() || null : null);
const typedOk = (v: unknown) => v === null || v === undefined || typeof v === "number" || typeof v === "string";
const textOk = (v: unknown, max: number) => v === null || v === undefined || (typeof v === "string" && v.length <= max);

/** The row to write for a load, or why not. */
export function buildCartageLoadRow(input: CartageLoadInput): { ok: true; row: CartageLoadRowFields } | { ok: false; error: string } {
  if (!isUuid(input.equipment_id)) return { ok: false, error: "Pick the truck." };
  if (!input.load_date || !realDate(input.load_date)) return { ok: false, error: "Pick the date." };
  if (!DIRECTIONS.has(input.direction)) return { ok: false, error: "Is it material in or spoil out?" };
  if (!UNITS.has(input.unit)) return { ok: false, error: "Pick tonnes, m³ or loads." };
  const row: CartageLoadRowFields = {
    equipment_id: input.equipment_id,
    load_date: input.load_date,
    direction: input.direction,
    material: text(input.material),
    supplier_id: input.direction === "material_in" && isUuid(input.supplier_id) ? input.supplier_id : null,
    place: text(input.place),
    from_text: text(input.from_text),
    to_text: text(input.to_text),
    quantity: typedNumber(input.quantity),
    unit: input.unit,
    km: typedNumber(input.km),
    docket_number: text(input.docket_number),
  };
  if (input.billing) row.billing = input.billing;
  for (const v of [row.quantity, row.km]) {
    if (v != null && (!Number.isFinite(v) || v < 0)) return { ok: false, error: "Check the numbers entered." };
  }
  if (row.quantity != null && row.quantity > 100_000) return { ok: false, error: "Check the quantity entered." };
  if (row.km != null && row.km > 5_000) return { ok: false, error: "Check the km entered." };
  // Spoil is charged per tonne or m³ off the tip docket (Justin) — a bare
  // "load" can't be priced, so say so now rather than at invoice time.
  if (row.direction === "spoil_out" && row.unit === "load" && input.billing !== "included") {
    return { ok: false, error: "Spoil is charged per tonne or m³ — enter the tonnes or m³ from the tip docket." };
  }
  return { ok: true, row };
}

/** A load sent to the API (the phone's add/edit), or why not. */
export function parseCartageLoadBody(body: unknown): { ok: true; id: string | null; input: CartageLoadInput } | { ok: false; error: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, error: "Send the load's details." };
  const b = body as Record<string, unknown>;
  if (b.id !== undefined && b.id !== null && !isUuid(b.id)) return { ok: false, error: "That load id isn't valid." };
  if (!isUuid(b.equipment_id)) return { ok: false, error: "Pick the truck." };
  if (typeof b.load_date !== "string" || !realDate(b.load_date)) return { ok: false, error: "Pick the date." };
  if (typeof b.direction !== "string" || !DIRECTIONS.has(b.direction)) return { ok: false, error: "Is it material in or spoil out?" };
  if (typeof b.unit !== "string" || !UNITS.has(b.unit)) return { ok: false, error: "Pick tonnes, m³ or loads." };
  if (b.billing !== undefined && b.billing !== null && (typeof b.billing !== "string" || !BILLINGS.has(b.billing))) {
    return { ok: false, error: "Is the load included in the price or extra?" };
  }
  if (b.supplier_id !== undefined && b.supplier_id !== null && !isUuid(b.supplier_id)) return { ok: false, error: "Pick the quarry again." };
  for (const k of ["quantity", "km"]) if (!typedOk(b[k])) return { ok: false, error: "Check the numbers entered." };
  for (const k of ["material", "place", "from_text", "to_text"]) {
    if (!textOk(b[k], 200)) return { ok: false, error: "Keep the material, quarry or tip, and from/to under 200 characters." };
  }
  if (!textOk(b.docket_number, 60)) return { ok: false, error: "Keep the docket number under 60 characters." };
  return {
    ok: true,
    id: (b.id as string | undefined) ?? null,
    input: {
      equipment_id: b.equipment_id,
      load_date: b.load_date,
      direction: b.direction as LoadDirection,
      material: (b.material as string | null | undefined) ?? null,
      supplier_id: (b.supplier_id as string | null | undefined) ?? null,
      place: (b.place as string | null | undefined) ?? null,
      from_text: (b.from_text as string | null | undefined) ?? null,
      to_text: (b.to_text as string | null | undefined) ?? null,
      quantity: b.quantity as Typed,
      unit: b.unit as LoadUnit,
      km: b.km as Typed,
      docket_number: (b.docket_number as string | null | undefined) ?? null,
      billing: (b.billing as LoadBilling | null | undefined) ?? null,
    },
  };
}

/** Why a load can't be signed yet, or null. The database enforces the same (0111). */
export function loadSignProblem(l: { quantity: number | string | null }): string | null {
  const q = l.quantity === null || l.quantity === "" ? 0 : Number(l.quantity);
  return Number.isFinite(q) && q > 0 ? null : "Enter how much was carted.";
}

// The database's own refusals (0111) that are written for the person tapping
// the button. Passed through only when the text matches one exactly;
// anything else gets a fixed sentence (tests/unit/no-raw-error-responses).
const KNOWN_REFUSALS = new Set([
  "Pick the truck from the fleet register.",
  "A truck load starts as a draft and is signed off afterwards.",
  "Only the office can void a truck load. Delete the draft instead.",
  "Enter the name of the builder's representative signing.",
  "The signature is missing. Ask them to sign again.",
  "Enter how much was carted before it is signed.",
  "This truck load is signed and locked. Ask the office if it needs changing.",
  "This truck load is signed and locked: its truck, date, quantities and docket cannot change. Void it and enter a new one.",
]);

/** What to tell the caller about a refused truck-load write. */
export function cartageWriteError(err: unknown): { status: number; error: string } {
  const e = (err ?? {}) as { code?: string; message?: string };
  const said = typeof e.message === "string" ? e.message : "";
  if (KNOWN_REFUSALS.has(said)) return { status: e.code === "42501" ? 403 : 400, error: said };
  switch (e.code) {
    case "42501":
      return { status: 403, error: "You can only log truck loads on jobs you're on." };
    case "23514":
      return { status: 400, error: "Check the numbers entered." };
    case "23503":
      return { status: 400, error: "That truck or quarry isn't in the register any more. Refresh and try again." };
    default:
      return { status: 500, error: "Couldn't save the load. Try again." };
  }
}

/** A base64 docket photo (JPEG, PNG or WebP; with or without its data: prefix), or why not. */
export function decodeDocketImage(v: unknown): { ok: true; bytes: Uint8Array; contentType: string; ext: string } | { ok: false; error: string } {
  if (typeof v !== "string" || v.length === 0) return { ok: false, error: "Take a photo of the docket." };
  const b64 = v.replace(/^data:image\/[a-z]+;base64,/, "");
  // ≤ 3 MB of image (base64 is 4/3 of that); Vercel caps a request at 4.5 MB.
  if (b64.length > 4_200_000) return { ok: false, error: "That photo is too big. Take it again." };
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) return { ok: false, error: "The photo couldn't be read. Take it again." };
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  if (bytes.length < 100) return { ok: false, error: "The photo couldn't be read. Take it again." };
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return { ok: true, bytes, contentType: "image/jpeg", ext: "jpg" };
  if ([0x89, 0x50, 0x4e, 0x47].every((x, i) => bytes[i] === x)) return { ok: true, bytes, contentType: "image/png", ext: "png" };
  if (String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" && String.fromCharCode(...bytes.slice(8, 12)) === "WEBP") {
    return { ok: true, bytes, contentType: "image/webp", ext: "webp" };
  }
  return { ok: false, error: "The docket photo must be a JPEG, PNG or WebP picture." };
}

/**
 * Where a load's docket photo is kept. The `expense-receipt-` segment is what
 * makes storage_object_is_money_document() (0047/0065) hide it from
 * technicians — a docket shows prices. 0111's end-state check pins it.
 */
export function docketPhotoPath(jobId: string, loadId: string, ext: string, now = Date.now()): string {
  return `${jobId}/expense-receipt-cartage-${loadId}-${now}.${ext}`;
}
