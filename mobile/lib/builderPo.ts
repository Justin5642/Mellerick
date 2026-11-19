// Mirror of lib/builder-po.ts for the phone's PO tab (office/admin). Change the web
// file first, then copy its body here — tests/unit/builder-po-mirror.test.ts
// fails when the two differ in anything but comments.
// A builder's purchase order on a job, split across the company's cost
// centres (Stage 2 of the 31 Oct 2026 workflow review). Justin: the builder
// issues a PO per stage (or we work to a quote total); each one's value is
// the budget, split by cost centre — the drainage PO covers Below Ground
// Drainage and the Transport (cartage) that goes with it.
//
// Stored in the existing tables: purchase_orders.po_number is the builder's
// number (or the job number for quoted work), purchase_orders.total_value is
// the PO's value as the builder wrote it, and each split line is a
// po_cost_centers row tagged with cost_centre_id (0087). The value is kept as
// entered, so lines that don't add up to it show as "unallocated" rather than
// silently changing what the builder agreed to pay. Left blank, the value is
// the lines' total (Nov 2026: a cartage PO with hours and no price yet).

export interface CostCentreOption {
  id: string;
  name: string;
}

export interface BuilderPoLineInput {
  /** The po_cost_centers row this line edits; absent for a new line. */
  id?: string;
  costCentreId: string;
  /** Optional stage under the cost centre ("Sewer"); blank = the cost centre itself. */
  stage: string;
  amount: string;
  hours: string;
}

export interface BuilderPoLineRow {
  cost_centre_id: string;
  name: string;
  allocated_amount: number;
  allocated_hours: number;
  sort_order: number;
}

export interface PlannedBuilderPo {
  value: number;
  totalHours: number;
  lines: BuilderPoLineRow[];
  /** value − sum of lines; negative = over-allocated. */
  unallocated: number;
}

const money = (n: number) => Math.round(n * 100) / 100;

function parseAmount(s: string): number | null {
  const t = s.replace(/[$,\s]/g, "");
  if (!t) return 0;
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** A blank line on the form: no cost centre and nothing typed. */
export function isBlankLine(l: BuilderPoLineInput): boolean {
  return !l.costCentreId && !l.stage.trim() && !l.amount.trim() && !l.hours.trim();
}

/** Checks the split lines alone (adding lines to a PO that already exists). */
export function planBuilderPoLines(
  input: BuilderPoLineInput[],
  costCentres: CostCentreOption[]
): { ok: true; lines: BuilderPoLineRow[]; totalHours: number } | { ok: false; error: string } {
  const lines: BuilderPoLineRow[] = [];
  for (const l of input) {
    if (isBlankLine(l)) continue;
    const centre = costCentres.find((c) => c.id === l.costCentreId);
    if (!centre) return { ok: false, error: "Pick a cost centre for every line." };
    const amount = parseAmount(l.amount);
    if (amount === null) return { ok: false, error: `Check the amount for ${l.stage.trim() || centre.name}.` };
    const hours = parseAmount(l.hours);
    if (hours === null) return { ok: false, error: `Check the hours for ${l.stage.trim() || centre.name}.` };
    lines.push({
      cost_centre_id: centre.id,
      name: l.stage.trim() || centre.name,
      allocated_amount: money(amount),
      allocated_hours: money(hours),
      sort_order: lines.length,
    });
  }
  return { ok: true, lines, totalHours: money(lines.reduce((s, l) => s + l.allocated_hours, 0)) };
}

const NO_PO = "Enter the PO value (ex GST), or split it across cost centres.";

/**
 * The PO's value as typed, or — left blank — the sum of its lines (Justin,
 * Nov 2026: a truck-cartage PO for a full job has hours but no price yet).
 * A PO needs a value or at least one line; with neither there is no PO.
 */
function resolveValue(
  raw: string,
  lines: { allocated_amount: number }[]
): { ok: true; value: number } | { ok: false; error: string } {
  const typed = raw.trim() !== "";
  const value = parseAmount(raw);
  if (value === null) return { ok: false, error: "Check the PO value (ex GST)." };
  if (lines.length === 0 && value <= 0) return { ok: false, error: NO_PO };
  if (!typed) return { ok: true, value: money(lines.reduce((s, l) => s + l.allocated_amount, 0)) };
  return { ok: true, value: money(value) };
}

/**
 * Checks the form and turns it into the rows to save. Errors are sentences
 * for the office. Lines are optional (a quote total can be split later), and
 * so is the value when there are lines: blank means the lines' total, which
 * may be $0 (a cartage line with hours only).
 */
export function planBuilderPo(
  input: { value: string; lines: BuilderPoLineInput[] },
  costCentres: CostCentreOption[]
): { ok: true; po: PlannedBuilderPo } | { ok: false; error: string } {
  const planned = planBuilderPoLines(input.lines, costCentres);
  if (!planned.ok) return planned;
  const resolved = resolveValue(input.value, planned.lines);
  if (!resolved.ok) return resolved;
  const allocated = planned.lines.reduce((s, l) => s + l.allocated_amount, 0);
  return {
    ok: true,
    po: {
      value: resolved.value,
      totalHours: planned.totalHours,
      lines: planned.lines,
      unallocated: money(resolved.value - allocated),
    },
  };
}

/** True when the form holds a PO at all: a value typed or any line filled in. */
export function hasBuilderPo(input: { value: string; lines: BuilderPoLineInput[] }): boolean {
  return input.value.trim() !== "" || input.lines.some((l) => !isBlankLine(l));
}

/** A saved po_cost_centers row, as the PO tab reads it. */
export interface SavedPoLine {
  id: string;
  name: string;
  cost_centre_id?: string | null;
  allocated_amount: number | string | null;
  allocated_hours: number | string | null;
}

/** A saved line back into the form: its stage is its name, unless that is just the cost centre's. */
export function lineInputFromSaved(row: SavedPoLine, costCentres: CostCentreOption[]): BuilderPoLineInput {
  const centre = costCentres.find((c) => c.id === row.cost_centre_id);
  const amount = Number(row.allocated_amount) || 0;
  const hours = Number(row.allocated_hours) || 0;
  return {
    id: row.id,
    costCentreId: row.cost_centre_id ?? "",
    stage: centre && centre.name === row.name ? "" : row.name,
    amount: amount ? amount.toFixed(2) : "",
    hours: hours ? String(hours) : "",
  };
}

export interface EditedLineRow {
  cost_centre_id: string | null;
  name: string;
  allocated_amount: number;
  allocated_hours: number;
  sort_order: number;
}

export interface PlannedBuilderPoEdit {
  value: number;
  totalHours: number;
  /** value − sum of lines; negative = over-allocated. */
  unallocated: number;
  /** Saved lines still on the form, updated in place by id. */
  updates: (EditedLineRow & { id: string })[];
  inserts: EditedLineRow[];
  /** Saved lines taken off the form. */
  deletes: string[];
}

/**
 * Checks the Edit form for a PO that already exists and works out the writes.
 * Saved lines are updated in place by id (supplier orders, time entries and
 * bookings point at them), new lines are inserted, and removed ones deleted —
 * unless something is recorded against them (`inUse`: line id → a sentence
 * saying what), which is refused. A saved line with no cost centre (a Simpro
 * line 0087 couldn't place) may stay untagged; a new line needs one.
 */
export function planBuilderPoEdit(
  input: { poNumber: string; value: string; lines: BuilderPoLineInput[] },
  saved: SavedPoLine[],
  costCentres: CostCentreOption[],
  inUse: Record<string, string> = {}
): { ok: true; edit: PlannedBuilderPoEdit } | { ok: false; error: string } {
  if (!input.poNumber.trim()) return { ok: false, error: "Enter the PO number." };
  const savedIds = new Set(saved.map((l) => l.id));
  const updates: PlannedBuilderPoEdit["updates"] = [];
  const inserts: EditedLineRow[] = [];
  const all: EditedLineRow[] = [];
  const kept = new Set<string>();
  for (const l of input.lines) {
    const existing = l.id && savedIds.has(l.id) && !kept.has(l.id) ? l.id : null;
    if (!existing && isBlankLine(l)) continue;
    const centre = costCentres.find((c) => c.id === l.costCentreId);
    const name = l.stage.trim() || centre?.name || "";
    if (!centre && !(existing && !l.costCentreId && name)) return { ok: false, error: "Pick a cost centre for every line." };
    const amount = parseAmount(l.amount);
    if (amount === null) return { ok: false, error: `Check the amount for ${name}.` };
    const hours = parseAmount(l.hours);
    if (hours === null) return { ok: false, error: `Check the hours for ${name}.` };
    const row: EditedLineRow = {
      cost_centre_id: centre?.id ?? null,
      name,
      allocated_amount: money(amount),
      allocated_hours: money(hours),
      sort_order: all.length,
    };
    all.push(row);
    if (existing) {
      kept.add(existing);
      updates.push({ id: existing, ...row });
    } else {
      inserts.push(row);
    }
  }
  const deletes = saved.filter((l) => !kept.has(l.id)).map((l) => l.id);
  for (const id of deletes) {
    if (inUse[id]) {
      const name = saved.find((l) => l.id === id)?.name ?? "That cost centre";
      return { ok: false, error: `${name} can't be removed: ${inUse[id]} Set its amount to $0 instead.` };
    }
  }
  const resolved = resolveValue(input.value, all);
  if (!resolved.ok) return resolved;
  const allocated = all.reduce((s, l) => s + l.allocated_amount, 0);
  return {
    ok: true,
    edit: {
      value: resolved.value,
      totalHours: money(all.reduce((s, l) => s + l.allocated_hours, 0)),
      unallocated: money(resolved.value - allocated),
      updates,
      inserts,
      deletes,
    },
  };
}

/** What a new line's amount starts at: whatever of the value is not yet split. */
export function remainingToSplit(value: string, lines: BuilderPoLineInput[]): string {
  const v = parseAmount(value);
  if (v === null || v <= 0) return "";
  const used = lines.reduce((s, l) => s + (parseAmount(l.amount) ?? 0), 0);
  const left = money(v - used);
  return left > 0 ? left.toFixed(2) : "";
}
