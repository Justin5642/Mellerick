import { supabase } from "./supabase";
import { fetchWithTimeout } from "./fetchWithTimeout";
import type { MeterReadings } from "./komtraxMeter";

// Day Works / Hire on the phone (Stage 2, Nov 2026; web routes under
// /api/jobs/[id]/hire-entries, migration 0108). The crew add the day's hire
// line — one machine, one day, quantities only — and the builder's rep signs
// it on the phone, after which it is locked.
//
// ONLINE ONLY, like supplier POs, on purpose: the builder signs on the spot,
// and an entry that only synced later couldn't be shown to them as locked.
// Not through the outbox, not in PowerSync (sync-streams.yaml has nothing for
// it). The routes write with the caller's own session, so RLS and the 0108
// lock trigger decide exactly as on the web.
//
// THE MONEY RULE: the server sends a technician names and quantities only.
// `pricing` exists only in an office/admin answer, and the tab renders it only
// through MoneyText / RoleGate.

const API_BASE_URL = process.env.EXPO_PUBLIC_API_BASE_URL;

export type HireType = "wet" | "dry" | "cartage" | "float";
export type HireUnit = "hour" | "day" | "engine_hour" | "km" | "contract" | "move";
export type HireStatus = "draft" | "signed" | "invoiced" | "void";

export interface DayWorksMachine {
  id: string;
  name: string;
  /** The server lists the whole active fleet (not tools). Empty = no hire rate yet: shown greyed, can't be picked. */
  options: { hire_type: HireType; hire_unit: HireUnit; label: string; whole_days_only: boolean; fuel_included: boolean }[];
}

export interface DayWorksEntry {
  id: string;
  equipment_id: string;
  equipment: string;
  hire_type: HireType;
  hire_unit: HireUnit;
  hire_label: string;
  work_date: string;
  hours: number | null;
  days: number | null;
  meter_open: number | null;
  meter_close: number | null;
  km: number | null;
  pickup: string | null;
  dropoff: string | null;
  description: string | null;
  cost_centre: string | null;
  status: HireStatus;
  signer_name: string | null;
  signed_at: string | null;
  signature_url: string | null;
  invoice_id: string | null;
  void_reason: string | null;
  attachment_ids: string[];
  created_by: string | null;
  created_by_name: string | null;
}

export interface DayWorksClash {
  attachment: string;
  work_date: string;
  machines: string[];
  entry_ids: string[];
}

/** Office/admin answers only. Never present for a technician. */
export interface DayWorksOfficePricing {
  entries: Record<string, { total: number | null }>;
  byCostCentre: { name: string; amount: number; entries: number; unpriced: number }[];
  uninvoicedSigned: number;
}

export type DayWorksState =
  | { ready: false }
  | {
      ready: true;
      isOffice: boolean;
      userId: string;
      machines: DayWorksMachine[];
      attachments: { id: string; name: string }[];
      entries: DayWorksEntry[];
      clashes: DayWorksClash[];
      pricing?: DayWorksOfficePricing;
      /** Komtrax hour-meter readings (0113) by machine and day — hours only. Absent from older servers. */
      meter_readings?: MeterReadings;
    };

/** What every write answers: the fresh tab, the entry saved, and any warning (an attachment clash). */
export type DayWorksWriteResult = DayWorksState & { saved?: { id: string }; warning?: string };

/** The body the add/edit routes take. Numbers as typed; the server checks them. */
export interface DayWorksEntryInput {
  id?: string;
  equipment_id: string;
  hire_type: HireType;
  hire_unit: HireUnit;
  work_date: string;
  hours: number | null;
  days: number | null;
  meter_open: number | null;
  meter_close: number | null;
  km: number | null;
  pickup: string | null;
  dropoff: string | null;
  description: string | null;
  attachment_ids: string[];
}

export const DAY_WORKS_OFFLINE = "Day Works needs signal. Try again when you have it.";

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
    throw new Error(`No connection. ${DAY_WORKS_OFFLINE}`);
  }
  // A non-JSON body (a platform error page) must still surface the status.
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `Server returned ${res.status}. Try again.`);
  return data as T;
}

const base = (jobId: string) => `/api/jobs/${encodeURIComponent(jobId)}/hire-entries`;

export function loadDayWorks(jobId: string): Promise<DayWorksState> {
  return call(base(jobId));
}

/** Safe to retry with the same `entry.id`: the server answers a second add as saved. */
export function addDayWorksEntry(jobId: string, entry: DayWorksEntryInput): Promise<DayWorksWriteResult> {
  return call(base(jobId), { method: "POST", body: JSON.stringify(entry) });
}

export function updateDayWorksEntry(jobId: string, entryId: string, entry: DayWorksEntryInput): Promise<DayWorksWriteResult> {
  return call(`${base(jobId)}/${encodeURIComponent(entryId)}`, { method: "PATCH", body: JSON.stringify(entry) });
}

export function deleteDayWorksEntry(jobId: string, entryId: string): Promise<DayWorksState> {
  return call(`${base(jobId)}/${encodeURIComponent(entryId)}`, { method: "DELETE" });
}

/** The builder's sign-off: their name and the signature as a base64 PNG (data: prefix allowed). */
export function signDayWorksEntry(jobId: string, entryId: string, signerName: string, signatureBase64: string): Promise<DayWorksWriteResult> {
  return call(`${base(jobId)}/${encodeURIComponent(entryId)}/sign`, {
    method: "POST",
    body: JSON.stringify({ signer_name: signerName, signature: signatureBase64 }),
  });
}

// ---------------------------------------------------------------------------
// Office/admin only (the routes refuse anyone else): void a signed line, and
// Invoice Day Works — the same routes the web tab uses.
// ---------------------------------------------------------------------------

/** Void a SIGNED line (final). Answers with the fresh tab. */
export function voidDayWorksEntry(jobId: string, entryId: string, reason: string | null): Promise<DayWorksState> {
  return call(`${base(jobId)}/${encodeURIComponent(entryId)}/void`, { method: "POST", body: JSON.stringify({ reason }) });
}

export interface DayWorksInvoiceRequest {
  entryIds: string[];
  /** Signed extra truck loads (0111) that go on the same invoice. */
  loadIds: string[];
  from: string;
  to: string;
}

/** One ordinary DRAFT invoice from the ticked signed lines and loads. */
export function invoiceDayWorks(jobId: string, req: DayWorksInvoiceRequest): Promise<{ ok: true; invoiceId: string; invoiceNumber: number | string | null }> {
  return call(`${base(jobId)}/invoice`, { method: "POST", body: JSON.stringify(req) });
}

// ---------------------------------------------------------------------------
// Pure helpers for the tab.
// ---------------------------------------------------------------------------

/** The form as typed. */
export interface DayWorksDraft {
  id: string | null;
  work_date: string;
  equipment_id: string;
  optionKey: string; // "<hire_type>|<hire_unit>"
  hours: string;
  days: string;
  meter_open: string;
  meter_close: string;
  km: string;
  pickup: string;
  dropoff: string;
  description: string;
  attachment_ids: string[];
  /** What Komtrax filled into the meter fields (lib/komtraxMeter.ts). */
  meter_auto?: { open: string; close: string } | null;
}

export function emptyDraft(today: string): DayWorksDraft {
  return { id: null, work_date: today, equipment_id: "", optionKey: "", hours: "", days: "", meter_open: "", meter_close: "", km: "", pickup: "", dropoff: "", description: "", attachment_ids: [] };
}

export function draftFromEntry(e: DayWorksEntry): DayWorksDraft {
  const s = (n: number | null) => (n == null ? "" : String(n));
  return {
    id: e.id,
    work_date: e.work_date,
    equipment_id: e.equipment_id,
    optionKey: `${e.hire_type}|${e.hire_unit}`,
    hours: s(e.hours),
    days: s(e.days),
    meter_open: s(e.meter_open),
    meter_close: s(e.meter_close),
    km: s(e.km),
    pickup: e.pickup ?? "",
    dropoff: e.dropoff ?? "",
    description: e.description ?? "",
    attachment_ids: e.attachment_ids,
  };
}

export const optionKey = (o: { hire_type: HireType; hire_unit: HireUnit }) => `${o.hire_type}|${o.hire_unit}`;

/** The picker's two groups (as the web's lib/day-works-view.ts): pickable, then still waiting for a hire rate. */
export function splitMachinesByHire(machines: DayWorksMachine[]): { ready: DayWorksMachine[]; noRate: DayWorksMachine[] } {
  return { ready: machines.filter((m) => m.options.length > 0), noRate: machines.filter((m) => m.options.length === 0) };
}

/** The machine's hire option the draft is on, or null. */
export function draftOption(draft: Pick<DayWorksDraft, "equipment_id" | "optionKey">, machines: DayWorksMachine[]): DayWorksMachine["options"][number] | null {
  return machines.find((m) => m.id === draft.equipment_id)?.options.find((o) => optionKey(o) === draft.optionKey) ?? null;
}

/** A typed number: blank → null; a comma works as the decimal point. */
const typed = (s: string): number | null => (s.trim() === "" ? null : Number(s.trim().replace(",", ".")));

/**
 * The request body for a draft, or why not — the same rules and words as the
 * web form (lib/day-works-entry.ts buildHireEntryRow), so the tech hears about
 * a problem before a round trip on one bar of signal.
 */
export function entryInputFromDraft(
  draft: DayWorksDraft,
  machines: DayWorksMachine[]
): { ok: true; input: DayWorksEntryInput } | { ok: false; error: string } {
  const opt = draftOption(draft, machines);
  if (!draft.equipment_id || !opt) return { ok: false, error: "Pick the machine and how it's hired." };
  if (!draft.work_date) return { ok: false, error: "Pick the date." };
  const { hire_type, hire_unit } = opt;
  const text = (s: string) => s.trim() || null;
  const fromTo = hire_unit === "move" || hire_type === "cartage";
  const input: DayWorksEntryInput = {
    ...(draft.id ? { id: draft.id } : {}),
    equipment_id: draft.equipment_id,
    hire_type,
    hire_unit,
    work_date: draft.work_date,
    hours: hire_unit === "hour" ? typed(draft.hours) : null,
    days: hire_unit === "day" ? typed(draft.days) : null,
    meter_open: hire_unit === "engine_hour" ? typed(draft.meter_open) : null,
    meter_close: hire_unit === "engine_hour" ? typed(draft.meter_close) : null,
    km: hire_unit === "km" || hire_unit === "move" ? typed(draft.km) : null,
    pickup: fromTo ? text(draft.pickup) : null,
    dropoff: fromTo ? text(draft.dropoff) : null,
    description: text(draft.description),
    // A float carries no attachments (the web hides them for floats too).
    attachment_ids: hire_type === "float" ? [] : draft.attachment_ids,
  };
  if (opt.whole_days_only && input.days != null && !Number.isInteger(input.days)) return { ok: false, error: "This machine is hired in full days only." };
  for (const v of [input.hours, input.days, input.meter_open, input.meter_close, input.km]) {
    if (v != null && (!Number.isFinite(v) || v < 0)) return { ok: false, error: "Check the numbers entered." };
  }
  if (input.hours != null && input.hours > 24) return { ok: false, error: "Hours can't be more than 24 in a day." };
  return { ok: true, input };
}

/**
 * Why an entry can't be signed yet, or null — the same rule as the web
 * (lib/hire-pricing.ts quantityProblem) and the database (0108).
 */
export function quantityProblem(e: Pick<DayWorksEntry, "hire_unit" | "hours" | "days" | "meter_open" | "meter_close" | "km">): string | null {
  const n = (v: number | null) => (v == null ? 0 : v);
  switch (e.hire_unit) {
    case "hour":
      return n(e.hours) > 0 ? null : "Enter the hours.";
    case "day":
      return n(e.days) > 0 ? null : "Enter the days.";
    case "engine_hour":
      if (e.meter_open == null || e.meter_close == null) return "Enter the opening and closing meter readings.";
      return e.meter_close > e.meter_open ? null : "The closing meter reading must be higher than the opening one.";
    case "km":
      return n(e.km) > 0 ? null : "Enter the kilometres.";
    case "move":
      return e.km == null ? "Enter the loaded kilometres (0 if none)." : null;
    case "contract":
      return null;
  }
}

/** One line saying what was done — the web tab's wording. No money. */
export function quantityText(e: Pick<DayWorksEntry, "hire_unit" | "hours" | "days" | "meter_open" | "meter_close" | "km" | "pickup" | "dropoff">): string {
  switch (e.hire_unit) {
    case "hour":
      return `${e.hours ?? 0} h`;
    case "day":
      return `${e.days ?? 0} day${e.days === 1 ? "" : "s"}`;
    case "engine_hour":
      return e.meter_open != null && e.meter_close != null
        ? `Meter ${e.meter_open} → ${e.meter_close} (${Math.round((e.meter_close - e.meter_open) * 10) / 10} engine h)`
        : "Meter readings missing";
    case "km":
      return `${e.km ?? 0} km`;
    case "contract":
      return "Contract";
    case "move": {
      const route = [e.pickup, e.dropoff].filter(Boolean).join(" → ");
      return `${route ? `${route} · ` : ""}${e.km ?? 0} km loaded`;
    }
  }
}

/** Entries by work date, newest day first; each day keeps the server's order. */
export function groupByDate(entries: DayWorksEntry[]): { date: string; entries: DayWorksEntry[] }[] {
  const byDate = new Map<string, DayWorksEntry[]>();
  for (const e of entries) {
    const list = byDate.get(e.work_date);
    if (list) list.push(e);
    else byDate.set(e.work_date, [e]);
  }
  return [...byDate.entries()].sort(([a], [b]) => (a < b ? 1 : a > b ? -1 : 0)).map(([date, list]) => ({ date, entries: list }));
}

/** "Mon 16 Nov 2026" from "2026-11-16", without the device's time zone moving the day. */
export function formatWorkDate(key: string): string {
  const [y, m, d] = key.split("-").map(Number);
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const dt = new Date(Date.UTC(y, m - 1, d));
  return `${days[dt.getUTCDay()]} ${d} ${months[m - 1]} ${y}`;
}

export const STATUS_LABEL: Record<HireStatus, string> = {
  draft: "Draft",
  signed: "Signed",
  invoiced: "Invoiced",
  void: "Void",
};

/** True for the network failure `call` throws, so the tab can say it needs signal. */
export function isOfflineError(e: unknown): boolean {
  return e instanceof Error && e.message.startsWith("No connection.");
}
