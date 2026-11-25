// What a mistake cost (Justin, 25 Nov 2026 — "do not double-enter cost").
// A mistake's cost lines (mistake_cost_lines, migration 0119 (a draft, not applied yet)) are either
//   • LINKS to a cost the CRM already holds — a time entry, an expense, a
//     supplier PO, an equipment usage or a Day Works line. The amount is
//     worked out from the source the same way the Job Ledger costs it
//     (lib/job-ledger.ts), every time it is shown, so it can never drift from
//     the record; it is ALREADY in the job's cost, so it is a SUBSET of it.
//   • MANUAL — an amount ex GST where no record exists. Only these ADD cost.
// Net cost = all lines − recovery received.
//
// How each link is costed:
//   time_entry      hours × the person's loaded rate (the line's hours when
//                   the office marked only part of the entry as rework, never
//                   more than the entry). Loaded rates are payroll data —
//                   admin only — so for office the hours show and the cost is
//                   "hidden" (counted as $0, flagged).
//   job_expense     its amount.
//   vendor_order    its amount; one not priced yet is "unpriced" ($0, flagged);
//                   a cancelled order cost nothing.
//   equipment_usage the ledger's plant cost (lib/fleet-costs.ts usageCost).
//   hire_entry      the Day Works line priced at today's hire rates
//                   (lib/hire-pricing.ts) — the machine time the mistake
//                   wasted. Hire isn't in the Job Ledger yet, so neither is
//                   this; it shows in the mistake's own cost.
//
// Pure. Office/admin only — amounts.

export const COST_KINDS = [
  { value: "labour", label: "Labour" },
  { value: "material", label: "Material" },
  { value: "plant", label: "Plant" },
  { value: "cartage", label: "Cartage" },
  { value: "subcontractor", label: "Subcontractor" },
  { value: "other", label: "Other" },
] as const;
export type CostKind = (typeof COST_KINDS)[number]["value"];

export const COST_SOURCES = ["time_entry", "job_expense", "vendor_order", "equipment_usage", "hire_entry", "manual"] as const;
export type CostSource = (typeof COST_SOURCES)[number];
export type LinkedSource = Exclude<CostSource, "manual">;

export const SOURCE_LABELS: Record<CostSource, string> = {
  time_entry: "Time entry",
  job_expense: "Expense",
  vendor_order: "Supplier PO",
  equipment_usage: "Equipment usage",
  hire_entry: "Day Works line",
  manual: "Manual",
};

/** The kind a linked line defaults to. */
export const DEFAULT_KIND: Record<LinkedSource, CostKind> = {
  time_entry: "labour",
  job_expense: "material",
  vendor_order: "material",
  equipment_usage: "plant",
  hire_entry: "plant",
};

export const RECOVERY_SOURCES = [
  { value: "supplier_credit", label: "Supplier credit" },
  { value: "builder_recharge", label: "Builder recharge" },
  { value: "insurance", label: "Insurance" },
  { value: "other", label: "Other" },
] as const;

export function costKindLabel(v: string | null | undefined): string {
  return COST_KINDS.find((k) => k.value === v)?.label ?? "Other";
}
export function recoverySourceLabel(v: string | null | undefined): string | null {
  return RECOVERY_SOURCES.find((k) => k.value === v)?.label ?? null;
}

export interface MistakeCostLine {
  id: string;
  mistake_id: string;
  kind: string;
  source: string;
  source_id: string | null;
  hours: number | null;
  amount_ex_gst: number | null;
  note: string | null;
  legacy: boolean;
  created_at: string;
}

/** The cost records links point at, as read for the lines in hand (id → row). */
export interface CostSources {
  timeEntries: Map<string, { staff_id: string; hours: number | null; entry_type?: string | null }>;
  /** Loaded $/hour by staff id; null = not visible to this viewer (office). */
  ratesByStaff: Map<string, number> | null;
  expenses: Map<string, { amount: number | null }>;
  vendorOrders: Map<string, { amount: number | null; status: string }>;
  /** Equipment usage id → its plant cost. */
  usage: Map<string, number>;
  /** Day Works line id → its priced total; null = the machine has no hire rate. */
  hire: Map<string, number | null>;
}

export function emptySources(): CostSources {
  return { timeEntries: new Map(), ratesByStaff: null, expenses: new Map(), vendorOrders: new Map(), usage: new Map(), hire: new Map() };
}

/** ok: costed. hidden: labour cost not visible to this viewer. unpriced: no amount yet. missing: the record is gone. */
export type LineCostStatus = "ok" | "hidden" | "unpriced" | "missing";

export interface LineCost {
  amount: number;
  status: LineCostStatus;
  /** Labour lines: the hours counted. */
  hours: number | null;
  linked: boolean;
}

const cents = (n: number) => Math.round(n * 100) / 100;
const num = (v: unknown) => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};

export function costLine(line: Pick<MistakeCostLine, "source" | "source_id" | "hours" | "amount_ex_gst">, src: CostSources): LineCost {
  const id = line.source_id ?? "";
  switch (line.source) {
    case "manual":
      return { amount: cents(num(line.amount_ex_gst)), status: "ok", hours: line.hours == null ? null : num(line.hours), linked: false };
    case "time_entry": {
      const t = src.timeEntries.get(id);
      if (!t) return { amount: 0, status: "missing", hours: null, linked: true };
      const entryHours = num(t.hours);
      const hours = line.hours != null ? Math.min(num(line.hours), entryHours) : entryHours;
      if (!src.ratesByStaff) return { amount: 0, status: "hidden", hours, linked: true };
      const rate = src.ratesByStaff.get(t.staff_id) ?? 0;
      return { amount: cents(hours * rate), status: rate > 0 ? "ok" : "unpriced", hours, linked: true };
    }
    case "job_expense": {
      const e = src.expenses.get(id);
      if (!e) return { amount: 0, status: "missing", hours: null, linked: true };
      return { amount: cents(num(e.amount)), status: "ok", hours: null, linked: true };
    }
    case "vendor_order": {
      const o = src.vendorOrders.get(id);
      if (!o) return { amount: 0, status: "missing", hours: null, linked: true };
      if (o.status === "cancelled") return { amount: 0, status: "ok", hours: null, linked: true };
      const amount = num(o.amount);
      return { amount: cents(amount), status: amount > 0 ? "ok" : "unpriced", hours: null, linked: true };
    }
    case "equipment_usage": {
      if (!src.usage.has(id)) return { amount: 0, status: "missing", hours: null, linked: true };
      return { amount: cents(num(src.usage.get(id))), status: "ok", hours: null, linked: true };
    }
    case "hire_entry": {
      if (!src.hire.has(id)) return { amount: 0, status: "missing", hours: null, linked: true };
      const total = src.hire.get(id);
      return total == null ? { amount: 0, status: "unpriced", hours: null, linked: true } : { amount: cents(total), status: "ok", hours: null, linked: true };
    }
    default:
      return { amount: 0, status: "missing", hours: null, linked: true };
  }
}

export interface MistakeMoney {
  /** Manual lines — new cost, added to the job's cost. */
  manual: number;
  /** Linked lines — already in the job's cost. */
  linked: number;
  /** manual + linked. */
  gross: number;
  /** Recovery received. */
  recovered: number;
  /** Recovery claimed. */
  claimed: number;
  /** gross − recovered. */
  net: number;
  /** Lines counted at $0 because they aren't priced, or the record is gone. */
  unpriced: number;
  /** Labour hours whose cost this viewer can't see (office). */
  hiddenHours: number;
}

export function mistakeMoney(
  lines: Pick<MistakeCostLine, "source" | "source_id" | "hours" | "amount_ex_gst">[],
  recovery: { recovered_ex_gst?: number | null; recovery_claimed_ex_gst?: number | null },
  src: CostSources
): MistakeMoney {
  let manual = 0;
  let linked = 0;
  let unpriced = 0;
  let hiddenHours = 0;
  for (const l of lines) {
    const c = costLine(l, src);
    if (c.linked) linked += c.amount;
    else manual += c.amount;
    if (c.status === "unpriced" || c.status === "missing") unpriced += 1;
    if (c.status === "hidden") hiddenHours += c.hours ?? 0;
  }
  const recovered = cents(num(recovery.recovered_ex_gst));
  const gross = cents(manual + linked);
  return {
    manual: cents(manual),
    linked: cents(linked),
    gross,
    recovered,
    claimed: cents(num(recovery.recovery_claimed_ex_gst)),
    net: cents(gross - recovered),
    unpriced,
    hiddenHours: cents(hiddenHours),
  };
}

/** Lines grouped by mistake id. */
export function linesByMistake<T extends { mistake_id: string }>(lines: T[]): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const l of lines) (m.get(l.mistake_id) ?? m.set(l.mistake_id, []).get(l.mistake_id)!).push(l);
  return m;
}

/** "already part of a mistake" — the source records already linked, as `${source}:${id}`. */
export function linkedKeys(lines: Pick<MistakeCostLine, "source" | "source_id">[]): Set<string> {
  return new Set(lines.filter((l) => l.source !== "manual" && l.source_id).map((l) => `${l.source}:${l.source_id}`));
}

export interface ManualLineForm {
  kind: string;
  amount: string;
  hours: string;
  note: string;
}

/** A manual line from the form, or the first problem as a sentence. */
export function buildManualLine(form: ManualLineForm):
  | { ok: true; row: { kind: CostKind; source: "manual"; amount_ex_gst: number; hours: number | null; note: string | null } }
  | { ok: false; error: string } {
  if (!COST_KINDS.some((k) => k.value === form.kind)) return { ok: false, error: "Pick what kind of cost it is." };
  const raw = form.amount.replace(/[$,\s]/g, "");
  const amount = Number(raw);
  if (!raw || !Number.isFinite(amount) || amount <= 0) return { ok: false, error: "Enter the cost (ex GST), more than $0." };
  if (amount >= 1e10) return { ok: false, error: "That amount is too large." };
  let hours: number | null = null;
  if (form.hours.trim()) {
    hours = Number(form.hours.trim());
    if (!Number.isFinite(hours) || hours <= 0 || hours > 10000) return { ok: false, error: "Hours must be more than 0." };
  }
  const note = form.note.trim();
  if (note.length > 500) return { ok: false, error: "Keep the note under 500 characters." };
  return { ok: true, row: { kind: form.kind as CostKind, source: "manual", amount_ex_gst: cents(amount), hours, note: note || null } };
}

export interface RecoveryForm {
  source: string;
  claimed: string;
  received: string;
  claimedOn: string;
  note: string;
}

/** The recovery columns from the form, or the first problem. Blank = none. */
export function buildRecovery(form: RecoveryForm):
  | {
      ok: true;
      row: {
        recovery_source: string | null;
        recovery_claimed_ex_gst: number | null;
        recovered_ex_gst: number | null;
        recovery_claimed_on: string | null;
        recovery_note: string | null;
      };
    }
  | { ok: false; error: string } {
  const money = (v: string, what: string): number | null | string => {
    const raw = v.replace(/[$,\s]/g, "");
    if (!raw) return null;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0 || n >= 1e10) return `Enter the amount ${what} as a number (ex GST).`;
    return cents(n);
  };
  const claimed = money(form.claimed, "claimed");
  if (typeof claimed === "string") return { ok: false, error: claimed };
  const received = money(form.received, "received");
  if (typeof received === "string") return { ok: false, error: received };
  if (form.source && !RECOVERY_SOURCES.some((s) => s.value === form.source)) return { ok: false, error: "Pick where the money comes back from." };
  if ((claimed || received) && !form.source) return { ok: false, error: "Pick where the money comes back from." };
  if (form.claimedOn && !/^\d{4}-\d{2}-\d{2}$/.test(form.claimedOn)) return { ok: false, error: "Enter the date it was claimed." };
  const note = form.note.trim();
  if (note.length > 1000) return { ok: false, error: "Keep the note under 1000 characters." };
  return {
    ok: true,
    row: {
      recovery_source: form.source || null,
      recovery_claimed_ex_gst: claimed,
      recovered_ex_gst: received,
      recovery_claimed_on: form.claimedOn || null,
      recovery_note: note || null,
    },
  };
}

/**
 * The Job Ledger's view of one mistake: which PO line it is on, what it adds
 * to cost (manual lines less recovery received — linked lines are already in
 * the job's cost) and its gross cost (the "of which mistakes" figure).
 */
export function ledgerMistake(
  m: { cost_center_id: string | null; recovered_ex_gst?: number | null; recovery_claimed_ex_gst?: number | null },
  lines: Pick<MistakeCostLine, "source" | "source_id" | "hours" | "amount_ex_gst">[],
  src: CostSources
): { cost_center_id: string | null; manual: number; linked: number; recovered: number } {
  const money = mistakeMoney(lines, m, src);
  return { cost_center_id: m.cost_center_id, manual: money.manual, linked: money.linked, recovered: money.recovered };
}
