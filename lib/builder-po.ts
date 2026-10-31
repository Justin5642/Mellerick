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
// silently changing what the builder agreed to pay.

export interface CostCentreOption {
  id: string;
  name: string;
}

export interface BuilderPoLineInput {
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

/**
 * Checks the form and turns it into the rows to save. Errors are sentences
 * for the office. Lines are optional (a quote total can be split later);
 * a value is not.
 */
export function planBuilderPo(
  input: { value: string; lines: BuilderPoLineInput[] },
  costCentres: CostCentreOption[]
): { ok: true; po: PlannedBuilderPo } | { ok: false; error: string } {
  const value = parseAmount(input.value);
  if (value === null || value <= 0) return { ok: false, error: "Enter the PO value (ex GST)." };
  const planned = planBuilderPoLines(input.lines, costCentres);
  if (!planned.ok) return planned;
  const allocated = planned.lines.reduce((s, l) => s + l.allocated_amount, 0);
  return {
    ok: true,
    po: {
      value: money(value),
      totalHours: planned.totalHours,
      lines: planned.lines,
      unallocated: money(value - allocated),
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
