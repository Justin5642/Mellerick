import { supabase } from "./supabase";
import { fetchWithTimeout } from "./fetchWithTimeout";

// Truck loads on the phone (migration 0111, drafted — not applied yet; web routes under
// /api/jobs/[id]/cartage-loads). The driver logs each trip on the job as it
// happens — quarry product IN, spoil OUT to a tip — with the docket number and
// a photo of the docket, and hands the phone to the builder's rep to sign the
// day's EXTRA loads at once.
//
// ONLINE ONLY, like Day Works and supplier POs: the builder signs on the spot.
// Not through the outbox, not in PowerSync (sync-streams.yaml has nothing for
// it). The routes write with the caller's own session, so RLS and 0111's lock
// trigger decide exactly as on the web. The docket photo goes up through the
// server: a docket shows prices, so it is stored where technicians can't read
// it back — the phone only hears that one is attached.
//
// THE MONEY RULE: the server sends a technician quantities only. `pricing`
// exists only in an office/admin answer, and the section renders it only
// through MoneyText / RoleGate.

const API_BASE_URL = process.env.EXPO_PUBLIC_API_BASE_URL;

export type LoadDirection = "material_in" | "spoil_out";
export type LoadUnit = "tonne" | "m3" | "load";
export type LoadBilling = "included" | "extra";
export type LoadStatus = "draft" | "signed" | "invoiced" | "void";

export interface TruckLoad {
  id: string;
  equipment_id: string;
  truck: string;
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
  has_docket_photo: boolean;
  billing: LoadBilling;
  cost_centre: string | null;
  status: LoadStatus;
  signer_name: string | null;
  signed_at: string | null;
  signature_url: string | null;
  invoice_id: string | null;
  void_reason: string | null;
  created_by: string | null;
  created_by_name: string | null;
}

/** Office/admin answers only. Never present for a technician. */
export interface TruckLoadsOfficePricing {
  companyMarginPct: number;
  loads: Record<string, { total: number | null; problem: string | null }>;
  uninvoicedSigned: number;
}

export type TruckLoadsState =
  | { ready: false }
  | {
      ready: true;
      isOffice: boolean;
      userId: string;
      trucks: { id: string; name: string }[];
      suppliers: { id: string; name: string; pinOrder: number | null }[];
      quarryIncluded: boolean | null;
      defaults: Record<LoadDirection, LoadBilling>;
      siteLabel: string | null;
      loads: TruckLoad[];
      pricing?: TruckLoadsOfficePricing;
    };

export type TruckLoadsWriteResult = TruckLoadsState & { saved?: { id: string }; signed?: string[] };

/** The body the add/edit routes take. */
export interface TruckLoadInput {
  id?: string;
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
  billing: LoadBilling;
}

export const TRUCK_LOADS_OFFLINE = "Truck loads need signal. Try again when you have it.";

async function call<T>(path: string, init: RequestInit = {}, timeoutMs?: number): Promise<T> {
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
    throw new Error(`No connection. ${TRUCK_LOADS_OFFLINE}`);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `Server returned ${res.status}. Try again.`);
  return data as T;
}

const base = (jobId: string) => `/api/jobs/${encodeURIComponent(jobId)}/cartage-loads`;

export function loadTruckLoads(jobId: string): Promise<TruckLoadsState> {
  return call(base(jobId));
}

/** Safe to retry with the same `load.id`: the server answers a second add as saved. */
export function addTruckLoad(jobId: string, load: TruckLoadInput): Promise<TruckLoadsWriteResult> {
  return call(base(jobId), { method: "POST", body: JSON.stringify(load) });
}

export function updateTruckLoad(jobId: string, loadId: string, load: TruckLoadInput): Promise<TruckLoadsWriteResult> {
  return call(`${base(jobId)}/${encodeURIComponent(loadId)}`, { method: "PATCH", body: JSON.stringify(load) });
}

export function deleteTruckLoad(jobId: string, loadId: string): Promise<TruckLoadsState> {
  return call(`${base(jobId)}/${encodeURIComponent(loadId)}`, { method: "DELETE" });
}

/** The docket photo as base64 JPEG (from lib/imageUpload.ts prepareImage). 60 s: it carries the photo up. */
export function attachDocketPhoto(jobId: string, loadId: string, imageBase64: string): Promise<TruckLoadsWriteResult> {
  return call(`${base(jobId)}/${encodeURIComponent(loadId)}/docket`, { method: "POST", body: JSON.stringify({ image: imageBase64 }) }, 60_000);
}

/** The builder's sign-off for several loads at once: their name and one signature (base64 PNG). */
export function signTruckLoads(jobId: string, loadIds: string[], signerName: string, signatureBase64: string): Promise<TruckLoadsWriteResult> {
  return call(`${base(jobId)}/sign`, { method: "POST", body: JSON.stringify({ load_ids: loadIds, signer_name: signerName, signature: signatureBase64 }) });
}

// ---------------------------------------------------------------------------
// Pure helpers for the section.
// ---------------------------------------------------------------------------

export interface TruckLoadDraft {
  id: string | null;
  direction: LoadDirection;
  load_date: string;
  equipment_id: string;
  supplier_id: string | null;
  place: string;
  material: string;
  quantity: string;
  unit: LoadUnit;
  km: string;
  docket_number: string;
  from_text: string;
  to_text: string;
  billing: LoadBilling;
  /** A docket photo taken in the form, uploaded after the load is saved. */
  photoUri: string | null;
}

/** A new load: the job's default included/extra for its direction (spoil → extra; quarry → the job's setting). */
export function newDraft(direction: LoadDirection, today: string, defaults: Record<LoadDirection, LoadBilling>, trucks: { id: string }[]): TruckLoadDraft {
  return {
    id: null,
    direction,
    load_date: today,
    equipment_id: trucks.length === 1 ? trucks[0].id : "",
    supplier_id: null,
    place: "",
    material: "",
    quantity: "",
    unit: "tonne",
    km: "",
    docket_number: "",
    from_text: "",
    to_text: "",
    billing: defaults[direction] ?? (direction === "spoil_out" ? "extra" : "included"),
    photoUri: null,
  };
}

export function draftFromLoad(l: TruckLoad): TruckLoadDraft {
  const s = (n: number | null) => (n == null ? "" : String(n));
  return {
    id: l.id,
    direction: l.direction,
    load_date: l.load_date,
    equipment_id: l.equipment_id,
    supplier_id: l.supplier_id,
    place: l.place ?? "",
    material: l.material ?? "",
    quantity: s(l.quantity),
    unit: l.unit,
    km: s(l.km),
    docket_number: l.docket_number ?? "",
    from_text: l.from_text ?? "",
    to_text: l.to_text ?? "",
    billing: l.billing,
    photoUri: null,
  };
}

const typed = (s: string): number | null => (s.trim() === "" ? null : Number(s.trim().replace(",", ".")));

/** The request body for a draft, or why not — the server's rules and words (lib/cartage-load-entry.ts). */
export function loadInputFromDraft(d: TruckLoadDraft): { ok: true; input: TruckLoadInput } | { ok: false; error: string } {
  if (!d.equipment_id) return { ok: false, error: "Pick the truck." };
  if (!d.load_date) return { ok: false, error: "Pick the date." };
  const text = (s: string) => s.trim() || null;
  const input: TruckLoadInput = {
    ...(d.id ? { id: d.id } : {}),
    equipment_id: d.equipment_id,
    load_date: d.load_date,
    direction: d.direction,
    material: d.direction === "material_in" ? text(d.material) : null,
    supplier_id: d.direction === "material_in" ? d.supplier_id : null,
    place: text(d.place),
    from_text: text(d.from_text),
    to_text: text(d.to_text),
    quantity: typed(d.quantity),
    unit: d.unit,
    km: typed(d.km),
    docket_number: text(d.docket_number),
    billing: d.billing,
  };
  for (const v of [input.quantity, input.km]) {
    if (v != null && (!Number.isFinite(v) || v < 0)) return { ok: false, error: "Check the numbers entered." };
  }
  if (input.direction === "spoil_out" && input.unit === "load" && input.billing !== "included") {
    return { ok: false, error: "Spoil is charged per tonne or m³ — enter the tonnes or m³ from the tip docket." };
  }
  if ((input.docket_number ?? "").length > 60) return { ok: false, error: "Keep the docket number under 60 characters." };
  return { ok: true, input };
}

const UNIT_SHORT: Record<LoadUnit, [string, string]> = { tonne: ["t", "t"], m3: ["m³", "m³"], load: ["load", "loads"] };
export const UNIT_LABEL: Record<LoadUnit, string> = { tonne: "Tonnes", m3: "m³", load: "Loads" };

/** "Spoil · 12 t · Site → Wollert tip · 35 km · docket 1234". No money. */
export function loadSummary(l: Pick<TruckLoad, "direction" | "material" | "quantity" | "unit" | "place" | "from_text" | "to_text" | "km" | "docket_number">, siteLabel: string | null): string {
  const what = l.direction === "material_in" ? l.material || "Quarry product" : "Spoil";
  const qty = l.quantity == null ? "quantity not entered" : `${l.quantity} ${l.quantity === 1 ? UNIT_SHORT[l.unit][0] : UNIT_SHORT[l.unit][1]}`;
  const site = siteLabel?.trim() || "job site";
  const from = l.from_text?.trim() || (l.direction === "spoil_out" ? site : l.place?.trim() || "");
  const to = l.to_text?.trim() || (l.direction === "spoil_out" ? l.place?.trim() || "" : site);
  const route = [from, to].filter(Boolean).join(" → ");
  return [what, qty, route || null, l.km == null ? null : `${l.km} km`, l.docket_number ? `docket ${l.docket_number}` : null].filter(Boolean).join(" · ");
}

/** The day's draft EXTRA loads the builder signs off together. Included loads need no signing. */
export function extrasToSign(loads: TruckLoad[], date: string): TruckLoad[] {
  return loads.filter((l) => l.load_date === date && l.status === "draft" && l.billing === "extra");
}

/** Why the builder can't sign these yet, or null (the database's rule: every load needs its quantity). */
export function signProblem(loads: Pick<TruckLoad, "quantity">[]): string | null {
  if (loads.length === 0) return "No extra loads to sign that day.";
  return loads.every((l) => l.quantity != null && l.quantity > 0) ? null : "Enter how much was carted on every load first.";
}

/** Loads by date, newest day first; each day keeps the server's order. */
export function groupLoadsByDate(loads: TruckLoad[]): { date: string; loads: TruckLoad[] }[] {
  const byDate = new Map<string, TruckLoad[]>();
  for (const l of loads) {
    const list = byDate.get(l.load_date);
    if (list) list.push(l);
    else byDate.set(l.load_date, [l]);
  }
  return [...byDate.entries()].sort(([a], [b]) => (a < b ? 1 : a > b ? -1 : 0)).map(([date, list]) => ({ date, loads: list }));
}

export function isTruckLoadsOffline(e: unknown): boolean {
  return e instanceof Error && e.message.startsWith("No connection.");
}
