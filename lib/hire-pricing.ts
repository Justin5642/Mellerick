// Day Works / Hire pricing (Stage 1, Nov 2026). Pure, so the job's Day Works
// tab, the invoice builder and later the reports price an entry the same way.
//
// Justin: hire and cartage are always their own line under a job, charged as
// Day Works — never inside the quoted value or a progress claim. Each machine
// has a hire type (wet hourly; dry by the day or by engine hour; cartage by
// the hour, km or contract; float = flat base + per km beyond what the base
// covers, loaded leg only). Attachments charge a full day when on a machine.
// Operator labour is a separate cost and is NOT in these rates.
//
// Everything here is ex GST. Rates come from the office-only tables
// (equipment_hire_options, hire_attachments); call this on office pages and
// office routes only. A technician's view of an entry is quantities only.

export type HireType = "wet" | "dry" | "cartage" | "float";
export type HireUnit = "hour" | "day" | "engine_hour" | "km" | "contract" | "move" | "tonne" | "m3";
/**
 * Units a Truck load (0111, drafted — not applied yet) is charged by, at the truck's own cartage rate.
 * Only for equipment_hire_options; a Day Works entry (hire_entries) never
 * uses them — its check constraint refuses them and the Day Works picker
 * leaves them out (lib/day-works-view.ts).
 */
export const LOAD_UNITS: HireUnit[] = ["tonne", "m3"];
export const isLoadUnit = (u: HireUnit) => u === "tonne" || u === "m3";
export type HireStatus = "draft" | "signed" | "invoiced" | "void";

/** Which units each hire type may be charged in — mirrors the table's check constraint. */
export const HIRE_UNITS_BY_TYPE: Record<HireType, HireUnit[]> = {
  wet: ["hour"],
  dry: ["day", "engine_hour"],
  cartage: ["hour", "km", "contract", "tonne", "m3"],
  float: ["move"],
};

export const HIRE_TYPE_LABELS: Record<HireType, string> = {
  wet: "Wet hire",
  dry: "Dry hire",
  cartage: "Cartage",
  float: "Float",
};

export const HIRE_UNIT_LABELS: Record<HireUnit, string> = {
  hour: "per hour",
  day: "per day",
  engine_hour: "per engine hour",
  km: "per km",
  contract: "contract",
  move: "per move",
  tonne: "per tonne (truck loads)",
  m3: "per m³ (truck loads)",
};

/** The company cost centre a hire type falls under when the setup names none. */
export const DEFAULT_COST_CENTRE_BY_TYPE: Record<HireType, string> = {
  wet: "Plant Wet Hire",
  dry: "Plant Dry Hire",
  cartage: "Truck Cartage",
  float: "Float Moves",
};

export function isValidHireUnit(type: HireType, unit: HireUnit): boolean {
  return HIRE_UNITS_BY_TYPE[type]?.includes(unit) ?? false;
}

export function hireOptionLabel(o: { hire_type: HireType; hire_unit: HireUnit }): string {
  if (o.hire_type === "float") return "Float move";
  if (o.hire_type === "dry" && o.hire_unit === "engine_hour") return "Dry hire, per engine hour";
  if (o.hire_type === "cartage" && o.hire_unit === "contract") return "Cartage, contract";
  return `${HIRE_TYPE_LABELS[o.hire_type]}, ${HIRE_UNIT_LABELS[o.hire_unit]}`;
}

/** equipment_hire_options row (office only). */
export interface HireOption {
  equipment_id: string;
  hire_type: HireType;
  hire_unit: HireUnit;
  rate: number | string | null;
  whole_days_only?: boolean | null;
  float_base?: number | string | null;
  float_km_included?: number | string | null;
  float_per_km?: number | string | null;
  cost_centre_id?: string | null;
}

/** hire_entries row — quantities only. */
export interface HireEntryQuantities {
  id: string;
  equipment_id: string;
  hire_type: HireType;
  hire_unit: HireUnit;
  work_date: string;
  hours?: number | string | null;
  days?: number | string | null;
  meter_open?: number | string | null;
  meter_close?: number | string | null;
  km?: number | string | null;
  status?: HireStatus | string;
  cost_centre_id?: string | null;
}

export interface HireAttachmentRate {
  id: string;
  name: string;
  day_rate: number | string | null;
}

const num = (v: number | string | null | undefined) => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};
const cents = (n: number) => Math.round(n * 100) / 100;
/** Quantities are stored to 2 dp (invoice_items.quantity is decimal(10,2)). */
const qty2 = (n: number) => Math.round(n * 100) / 100;

/** The hire option an entry was entered under. */
export function optionFor(entry: Pick<HireEntryQuantities, "equipment_id" | "hire_type" | "hire_unit">, options: HireOption[]): HireOption | null {
  return options.find((o) => o.equipment_id === entry.equipment_id && o.hire_type === entry.hire_type && o.hire_unit === entry.hire_unit) ?? null;
}

/**
 * Why an entry can't be signed yet, or null. The database enforces the same
 * rule on sign-off (hire_entries_guard); this is the friendly early check.
 */
export function quantityProblem(e: Pick<HireEntryQuantities, "hire_unit" | "hours" | "days" | "meter_open" | "meter_close" | "km">): string | null {
  switch (e.hire_unit) {
    case "hour":
      return num(e.hours) > 0 ? null : "Enter the hours.";
    case "day":
      return num(e.days) > 0 ? null : "Enter the days.";
    case "engine_hour":
      if (e.meter_open == null || e.meter_open === "" || e.meter_close == null || e.meter_close === "") return "Enter the opening and closing meter readings.";
      return num(e.meter_close) > num(e.meter_open) ? null : "The closing meter reading must be higher than the opening one.";
    case "km":
      return num(e.km) > 0 ? null : "Enter the kilometres.";
    case "move":
      return e.km == null || e.km === "" ? "Enter the loaded kilometres (0 if none)." : null;
    case "contract":
      return null;
    case "tonne":
    case "m3":
      return "Truck loads are entered under Truck loads, not as a Day Works line.";
  }
}

/**
 * What one entry's machine is charged: a quantity, a unit price and their
 * product, rounded to cents. A float move is quantity 1 at its whole price, so
 * an invoice line shows exactly the amount priced here.
 */
export function machineCharge(e: HireEntryQuantities, o: HireOption): { quantity: number; unitPrice: number; amount: number } {
  const rate = num(o.rate);
  let quantity: number;
  let unitPrice = rate;
  switch (e.hire_unit) {
    case "hour":
      quantity = qty2(num(e.hours));
      break;
    case "day": {
      const days = num(e.days);
      // The roller: "per full day, no half days" — any part day is a full one.
      quantity = o.whole_days_only ? Math.ceil(days - 1e-9) : qty2(days);
      break;
    }
    case "engine_hour":
      quantity = qty2(Math.max(0, num(e.meter_close) - num(e.meter_open)));
      break;
    case "km":
      quantity = qty2(num(e.km));
      break;
    case "contract":
      quantity = 1;
      break;
    case "move": {
      quantity = 1;
      unitPrice = floatMoveCharge(num(e.km), o);
      break;
    }
    case "tonne":
    case "m3":
      // Never a Day Works entry's unit (0111 keeps them to Truck loads, priced
      // by lib/cartage-pricing.ts); nothing to charge here.
      quantity = 0;
      break;
  }
  return { quantity, unitPrice: cents(unitPrice), amount: cents(quantity * cents(unitPrice)) };
}

/** Float: the base covers the first `float_km_included` km; each km beyond is `float_per_km`. 50 km on the quad = 470 + 20 × 5 = 570. */
export function floatMoveCharge(km: number, o: Pick<HireOption, "float_base" | "float_km_included" | "float_per_km">): number {
  const extra = Math.max(0, km - num(o.float_km_included));
  return cents(num(o.float_base) + extra * num(o.float_per_km));
}

export interface PricedEntry {
  id: string;
  machine: { quantity: number; unitPrice: number; amount: number } | null;
  attachments: { id: string; name: string; amount: number }[];
  /** null when the machine's hire setup is missing — the office must set it up before invoicing. */
  total: number | null;
  cost_centre_id: string | null;
}

/** An entry's full charge: the machine plus each attachment at a full day. */
export function priceEntry(
  e: HireEntryQuantities,
  options: HireOption[],
  attachmentIds: string[],
  attachments: HireAttachmentRate[]
): PricedEntry {
  const o = optionFor(e, options);
  const byId = new Map(attachments.map((a) => [a.id, a]));
  const atts = attachmentIds.map((id) => {
    const a = byId.get(id);
    return { id, name: a?.name ?? "Attachment", amount: cents(num(a?.day_rate)) };
  });
  const machine = o ? machineCharge(e, o) : null;
  return {
    id: e.id,
    machine,
    attachments: atts,
    total: machine ? cents(machine.amount + atts.reduce((s, a) => s + a.amount, 0)) : null,
    cost_centre_id: e.cost_centre_id ?? o?.cost_centre_id ?? null,
  };
}

export interface AttachmentClash {
  attachmentId: string;
  workDate: string;
  /** The entries (different machines) the attachment is ticked on that day. */
  entryIds: string[];
  equipmentIds: string[];
}

/**
 * The same attachment ticked on two different machines on the same day. It can
 * only be on one machine at a time, so one of the ticks is wrong (or it is
 * being charged twice). Void entries don't count. A flag, not a block.
 */
export function attachmentClashes(
  entries: { id: string; equipment_id: string; work_date: string; status?: string | null; attachment_ids: string[] }[]
): AttachmentClash[] {
  const groups = new Map<string, { entryIds: string[]; equipment: Set<string> }>();
  for (const e of entries) {
    if (e.status === "void") continue;
    for (const a of new Set(e.attachment_ids)) {
      const key = `${a}|${e.work_date}`;
      const g = groups.get(key) ?? { entryIds: [], equipment: new Set<string>() };
      g.entryIds.push(e.id);
      g.equipment.add(e.equipment_id);
      groups.set(key, g);
    }
  }
  const out: AttachmentClash[] = [];
  for (const [key, g] of groups) {
    if (g.equipment.size < 2) continue;
    const [attachmentId, workDate] = key.split("|");
    out.push({ attachmentId, workDate, entryIds: g.entryIds, equipmentIds: [...g.equipment] });
  }
  return out.sort((a, b) => a.workDate.localeCompare(b.workDate) || a.attachmentId.localeCompare(b.attachmentId));
}

/** Amounts added up by cost centre (null = not tagged), in first-seen order. Unpriced entries are counted separately. */
export function totalsByCostCentre(priced: Pick<PricedEntry, "total" | "cost_centre_id">[]): { cost_centre_id: string | null; amount: number; entries: number; unpriced: number }[] {
  const m = new Map<string | null, { cost_centre_id: string | null; amount: number; entries: number; unpriced: number }>();
  for (const p of priced) {
    const k = p.cost_centre_id ?? null;
    const t = m.get(k) ?? { cost_centre_id: k, amount: 0, entries: 0, unpriced: 0 };
    t.entries += 1;
    if (p.total === null) t.unpriced += 1;
    else t.amount = cents(t.amount + p.total);
    m.set(k, t);
  }
  return [...m.values()];
}

export interface DayWorksInvoiceLine {
  name: string;
  description: string;
  quantity: number;
  unit_price: number;
}

const UNIT_WORDS: Record<HireUnit, [string, string]> = {
  hour: ["hour", "hours"],
  day: ["day", "days"],
  engine_hour: ["engine hour", "engine hours"],
  km: ["km", "km"],
  contract: ["contract", "contract"],
  move: ["move", "moves"],
  tonne: ["tonne", "tonnes"],
  m3: ["m³", "m³"],
};

function fmtDate(key: string): string {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

function qtyText(n: number, unit: HireUnit): string {
  const [one, many] = UNIT_WORDS[unit];
  return `${n} ${n === 1 ? one : many}`;
}

export interface InvoiceableEntry extends HireEntryQuantities {
  description?: string | null;
  pickup?: string | null;
  dropoff?: string | null;
  signer_name?: string | null;
  attachment_ids: string[];
}

/**
 * Invoice lines for signed, un-invoiced entries, oldest first: one line for
 * each machine-day, then one per attachment on it. Throws when an entry is not
 * signed or its machine has no hire setup — invoicing it at $0 would undercharge
 * without saying so.
 */
export function invoiceLinesFromEntries(
  entries: InvoiceableEntry[],
  options: HireOption[],
  attachments: HireAttachmentRate[],
  equipmentNames: Map<string, string>
): DayWorksInvoiceLine[] {
  const lines: DayWorksInvoiceLine[] = [];
  const sorted = [...entries].sort((a, b) => a.work_date.localeCompare(b.work_date) || (equipmentNames.get(a.equipment_id) ?? "").localeCompare(equipmentNames.get(b.equipment_id) ?? ""));
  for (const e of sorted) {
    if (e.status !== "signed") throw new Error("Only signed Day Works entries that are not yet invoiced can be invoiced.");
    const o = optionFor(e, options);
    const machineName = equipmentNames.get(e.equipment_id) ?? "Machine";
    if (!o) throw new Error(`${machineName} has no hire rate for ${hireOptionLabel(e).toLowerCase()}. Set it up in Fleet first.`);
    const priced = priceEntry(e, options, e.attachment_ids, attachments);
    const m = priced.machine!;
    const parts = [fmtDate(e.work_date)];
    if (e.hire_unit === "engine_hour") parts.push(`meter ${num(e.meter_open)}–${num(e.meter_close)} = ${qtyText(m.quantity, "engine_hour")}`);
    else if (e.hire_unit === "move") {
      const route = [e.pickup, e.dropoff].filter((s) => s && s.trim()).join(" → ");
      parts.push(`${route ? `${route}, ` : ""}${num(e.km)} km loaded`);
    } else if (e.hire_unit === "day" && o.whole_days_only && m.quantity !== num(e.days)) parts.push(`${num(e.days)} days used, charged in full days`);
    if (e.description?.trim()) parts.push(e.description.trim());
    if (e.signer_name?.trim()) parts.push(`signed by ${e.signer_name.trim()}`);
    lines.push({
      name: `${machineName} — ${hireOptionLabel(e)}`,
      description: parts.join(" · "),
      quantity: m.quantity,
      unit_price: m.unitPrice,
    });
    for (const a of priced.attachments) {
      lines.push({ name: `${a.name} (on ${machineName})`, description: `${fmtDate(e.work_date)} · full day`, quantity: 1, unit_price: a.amount });
    }
  }
  return lines;
}

/** "3 Nov – 9 Nov 2026", or one date. */
export function dayWorksPeriodLabel(from: string, to: string): string {
  if (from === to) return fmtDate(from);
  const [fy] = from.split("-");
  const [ty] = to.split("-");
  const start = fmtDate(from);
  return `${fy === ty ? start.replace(/ \d{4}$/, "") : start} – ${fmtDate(to)}`;
}

export function dayWorksInvoiceTitle(from: string, to: string): string {
  return `Day Works / Hire — ${dayWorksPeriodLabel(from, to)}`;
}
