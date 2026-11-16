// One Day Works / Hire entry as typed in (Stage 1 web tab, Stage 2 phone).
// Pure, shared by the web tab (components/job/job-day-works.tsx), which writes
// under RLS from the browser, and the API routes the phone calls
// (app/api/jobs/[id]/hire-entries/...), so both refuse the same things with
// the same words. The database (0108's hire_entries_guard) is still the last
// word; this is the friendly early check.
//
// No money here: the hire option passed in is the flags the crew may see
// (hire type, unit, whole days only), never a rate.

import type { HireType, HireUnit } from "@/lib/hire-pricing";
import type { DayWorksClash } from "@/lib/day-works-view";

/** A number as typed: a string from a text field, or a number from JSON. */
export type Typed = string | number | null | undefined;

export interface HireEntryInput {
  equipment_id: string;
  hire_type: HireType | "";
  hire_unit: HireUnit | "";
  work_date: string;
  hours?: Typed;
  days?: Typed;
  meter_open?: Typed;
  meter_close?: Typed;
  km?: Typed;
  pickup?: string | null;
  dropoff?: string | null;
  description?: string | null;
}

/** The machine's hire option, as the crew may see it. Null = not set up for that hire. */
export interface HireOptionFlags {
  hire_type: HireType;
  hire_unit: HireUnit;
  whole_days_only?: boolean | null;
}

/** The hire_entries columns an entry writes (job_id is the caller's to add). */
export interface HireEntryRowFields {
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
}

/** Blank → null; otherwise Number() (so "abc" is NaN and refused below). */
export function typedNumber(v: Typed): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return v;
  return v.trim() === "" ? null : Number(v);
}

const text = (v: string | null | undefined) => (typeof v === "string" ? v.trim() || null : null);

/**
 * The row to write for an entry, or why not. Only the fields for the entry's
 * unit are kept (hours for hourly, days for daily, meter readings for engine
 * hours, km for km and float moves, from/to for floats and cartage).
 */
export function buildHireEntryRow(
  input: HireEntryInput,
  opt: HireOptionFlags | null
): { ok: true; row: HireEntryRowFields } | { ok: false; error: string } {
  if (!input.equipment_id || !opt || opt.hire_type !== input.hire_type || opt.hire_unit !== input.hire_unit) {
    return { ok: false, error: "Pick the machine and how it's hired." };
  }
  if (!input.work_date) return { ok: false, error: "Pick the date." };
  const { hire_type, hire_unit } = opt;
  const row: HireEntryRowFields = {
    equipment_id: input.equipment_id,
    hire_type,
    hire_unit,
    work_date: input.work_date,
    hours: hire_unit === "hour" ? typedNumber(input.hours) : null,
    days: hire_unit === "day" ? typedNumber(input.days) : null,
    meter_open: hire_unit === "engine_hour" ? typedNumber(input.meter_open) : null,
    meter_close: hire_unit === "engine_hour" ? typedNumber(input.meter_close) : null,
    km: hire_unit === "km" || hire_unit === "move" ? typedNumber(input.km) : null,
    pickup: hire_unit === "move" || hire_type === "cartage" ? text(input.pickup) : null,
    dropoff: hire_unit === "move" || hire_type === "cartage" ? text(input.dropoff) : null,
    description: text(input.description),
  };
  if (opt.whole_days_only && row.days != null && !Number.isInteger(row.days)) {
    return { ok: false, error: "This machine is hired in full days only." };
  }
  for (const v of [row.hours, row.days, row.meter_open, row.meter_close, row.km]) {
    if (v != null && (!Number.isFinite(v) || v < 0)) return { ok: false, error: "Check the numbers entered." };
  }
  return { ok: true, row };
}

/** The warning for one entry's attachment clashes, or null. No figures. */
export function clashWarning(clashes: DayWorksClash[], entryId: string): string | null {
  const mine = clashes.filter((c) => c.entry_ids.includes(entryId));
  if (mine.length === 0) return null;
  return mine
    .map((c) => `${c.attachment} is ticked on ${c.machines.join(" and ")} on ${c.work_date}. It can only be on one — check which is right so it isn't charged twice.`)
    .join(" ");
}

// The database's own refusals (0108) that are written for the person tapping
// the button. Passed through only when the text matches one of these exactly;
// anything else gets a fixed sentence (tests/unit/no-raw-error-responses).
const KNOWN_REFUSALS = new Set([
  "That machine is not set up for this kind of hire. Ask the office to add it in Fleet → Hire setup.",
  "Enter the name of the builder's representative signing.",
  "The signature is missing. Ask them to sign again.",
  "Enter the quantity for this hire before it is signed.",
  "This Day Works entry is signed and locked. Ask the office if it needs changing.",
  "This Day Works entry is signed and locked: its attachments cannot change.",
  "A Day Works entry starts as a draft and is signed off afterwards.",
  "Only the office can void a Day Works entry. Delete the draft instead.",
]);

/** What to tell the caller about a refused Day Works write. */
export function dayWorksWriteError(err: unknown): { status: number; error: string } {
  const e = (err ?? {}) as { code?: string; message?: string };
  const said = typeof e.message === "string" ? e.message : "";
  if (KNOWN_REFUSALS.has(said)) return { status: e.code === "42501" ? 403 : 400, error: said };
  switch (e.code) {
    case "23505":
      return { status: 409, error: "This machine already has a Day Works line for that day on this job. Edit that one instead." };
    case "42501":
      return { status: 403, error: "You can only add Day Works on jobs you're on." };
    case "23514":
      return { status: 400, error: "Check the numbers entered." };
    case "23503":
      return { status: 400, error: "That machine or attachment isn't in the register any more. Refresh and try again." };
    default:
      return { status: 500, error: "Couldn't save the entry. Try again." };
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;
const HIRE_TYPES = new Set<string>(["wet", "dry", "cartage", "float"]);
const HIRE_UNITS = new Set<string>(["hour", "day", "engine_hour", "km", "contract", "move"]);
const MAX_ATTACHMENTS = 20;

export const isUuid = (v: unknown): v is string => typeof v === "string" && UUID.test(v);

function realDate(key: string): boolean {
  if (!DATE_KEY.test(key)) return false;
  const [y, m, d] = key.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

const typedOk = (v: unknown) => v === null || v === undefined || typeof v === "number" || typeof v === "string";
const textOk = (v: unknown, max: number) => v === null || v === undefined || (typeof v === "string" && v.length <= max);

/**
 * A Day Works entry sent to the API (the phone's add/edit). Checks the shape
 * the browser form guarantees by construction; buildHireEntryRow then applies
 * the same rules as the web form.
 */
export function parseHireEntryBody(
  body: unknown
): { ok: true; id: string | null; input: HireEntryInput & { hire_type: HireType; hire_unit: HireUnit }; attachmentIds: string[] } | { ok: false; error: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, error: "Send the entry's details." };
  const b = body as Record<string, unknown>;
  if (b.id !== undefined && b.id !== null && !isUuid(b.id)) return { ok: false, error: "That entry id isn't valid." };
  if (!isUuid(b.equipment_id) || typeof b.hire_type !== "string" || !HIRE_TYPES.has(b.hire_type) || typeof b.hire_unit !== "string" || !HIRE_UNITS.has(b.hire_unit)) {
    return { ok: false, error: "Pick the machine and how it's hired." };
  }
  if (typeof b.work_date !== "string" || !realDate(b.work_date)) return { ok: false, error: "Pick the date." };
  for (const k of ["hours", "days", "meter_open", "meter_close", "km"]) {
    if (!typedOk(b[k])) return { ok: false, error: "Check the numbers entered." };
  }
  if (!textOk(b.pickup, 200) || !textOk(b.dropoff, 200)) return { ok: false, error: "Keep the pick-up and drop-off under 200 characters." };
  if (!textOk(b.description, 4000)) return { ok: false, error: "Keep the description under 4,000 characters." };
  const rawAttachments = b.attachment_ids ?? [];
  if (!Array.isArray(rawAttachments) || rawAttachments.length > MAX_ATTACHMENTS || !rawAttachments.every(isUuid)) {
    return { ok: false, error: "Check the attachments ticked." };
  }
  const attachmentIds = [...new Set(rawAttachments as string[])];
  if (b.hire_type === "float" && attachmentIds.length > 0) return { ok: false, error: "A float move doesn't take attachments." };
  return {
    ok: true,
    id: (b.id as string | undefined) ?? null,
    attachmentIds,
    input: {
      equipment_id: b.equipment_id,
      hire_type: b.hire_type as HireType,
      hire_unit: b.hire_unit as HireUnit,
      work_date: b.work_date,
      hours: b.hours as Typed,
      days: b.days as Typed,
      meter_open: b.meter_open as Typed,
      meter_close: b.meter_close as Typed,
      km: b.km as Typed,
      pickup: (b.pickup as string | null | undefined) ?? null,
      dropoff: (b.dropoff as string | null | undefined) ?? null,
      description: (b.description as string | null | undefined) ?? null,
    },
  };
}

/** Limits the table's check constraints would refuse with no explanation. */
export function rowLimitProblem(row: HireEntryRowFields): string | null {
  if (row.hours != null && row.hours > 24) return "Hours can't be more than 24 in a day.";
  if (row.meter_open != null && row.meter_close != null && row.meter_close < row.meter_open) {
    return "The closing meter reading must be higher than the opening one.";
  }
  return null;
}

/** A base64 PNG signature (with or without its data: prefix), or why not. */
export function decodeSignaturePng(v: unknown): { ok: true; bytes: Uint8Array } | { ok: false; error: string } {
  if (typeof v !== "string" || v.length === 0) return { ok: false, error: "Ask them to sign in the box." };
  const b64 = v.replace(/^data:image\/png;base64,/, "");
  if (b64.length > 1_400_000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) {
    return { ok: false, error: "The signature couldn't be read. Clear it and sign again." };
  }
  // atob, not Buffer: this file is also bundled for the browser (the web tab).
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < 64 || !PNG.every((x, i) => bytes[i] === x)) {
    return { ok: false, error: "The signature couldn't be read. Clear it and sign again." };
  }
  return { ok: true, bytes };
}
