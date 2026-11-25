import { computeLoadedCost } from "@/lib/staff-cost";
import type { EquipmentCostInputs } from "@/lib/equipment-cost";
import { costPerHourOf, usageCost, type EffectiveRate } from "@/lib/fleet-costs";

// The job ledger (Stage 3 of the 31 Oct 2026 workflow review): for one job,
// per company cost centre, the budget from the builder's PO split (Stage 2)
// against what the job has cost so far — labour, materials, plant — and the
// margin that leaves. Justin: "I can see live margin and whether a job is
// worth doing. Pricing is getting lean, so this is a priority."
//
// Pure, so the job's Costing tab and the open-jobs list compute it the same
// way. Everything is ex GST. Costing follows the Costing tab's existing rules
// (lib/staff-cost.ts loaded rates, plant at lib/fleet-costs.ts costPerHourOf —
// the actual rate from logged Fleet costs once there is enough, else the
// lib/equipment-cost.ts estimate — and the
// vehicle double-count guard), now split by cost centre:
//
//   budget     po_cost_centers.allocated_amount, by cost_centre_id (0087)
//   labour     work hours × the person's loaded rate, by the entry's line
//   travel     travel hours × loaded rate — its own row, it has no line
//   materials  job_expenses + priced supplier orders, by line. A supplier
//              order with no amount yet is counted as "to be priced", not $0.
//   plant      equipment usage: hours × cost per hour, plus loads × cost per
//              load (0091), by the usage's line — the truck's cartage on the
//              Transport line. Untagged usage lands in "Not tagged".
//   mistakes   job_mistakes (0115) and their cost lines (0119, a draft not applied yet), by the PO
//              line the mistake is on (lib/mistake-costs.ts). DON'T
//              DOUBLE-COUNT (Justin, 25 Nov 2026): a LINKED line (a time
//              entry, expense, supplier PO… marked as part of a mistake) is
//              already counted above, so mistakes are shown as a SUBSET of
//              cost — the "mistakes" figure — and only MANUAL lines add cost,
//              less any recovery received (a supplier credit, a builder
//              recharge, insurance) — the "mistakesAdded" figure. A 0115-only
//              row ({ amount_ex_gst }) is a manual line.
//
//   variations time, plant, expenses and supplier POs that belong to a
//              VARIATION (0120 (draft) — time_entries.variation_id, and the office's
//              variation_cost_links) are costed under that variation's own
//              row, NOT under the stage's line — each record once. The row's
//              budget is the variation's price (approved / auto-approved:
//              total_amount, else rate × quantity; nothing while it waits for
//              the office), and the job's price is the builder's PO total
//              PLUS the approved variations (Justin, 25 Nov 2026: "the
//              variation can be costed and the stage's allowed hours stay a
//              fair measure"). A rejected variation's costs stay on their
//              stage (0120 (draft) also hands its time back), and so does anything
//              tagged to a variation the caller didn't pass.
//
// Known overlap until supplier invoices are matched to POs (Stage 4): the
// same invoice entered both as an expense and as an order's amount counts
// twice.

export interface StaffCostProfileInput {
  staff_id: string;
  hourly_rate: number;
  super_rate: number;
  workers_comp_rate: number;
  leave_loading_rate: number;
  annual_fixed_oncosts: number;
  target_hours_per_week: number;
}

export interface EquipmentInput extends EquipmentCostInputs {
  id: string;
  assigned_to?: string | null;
  /** $ per load carted (0091). */
  cost_per_load?: number | null;
  /** $ per day used (0100). */
  day_rate?: number | null;
  /** Attached by lib/fleet-rates.ts; absent = cost at the estimate. */
  effective_rate?: EffectiveRate | null;
}

/** Each person's loaded $/hour, with any vehicle assigned to them folded in. */
export function loadedRatesByStaff(profiles: StaffCostProfileInput[], equipment: EquipmentInput[]): Map<string, number> {
  const vehicleByStaff = new Map<string, number>();
  for (const eq of equipment) {
    if (!eq.assigned_to) continue;
    vehicleByStaff.set(eq.assigned_to, (vehicleByStaff.get(eq.assigned_to) ?? 0) + costPerHourOf(eq));
  }
  return new Map(
    profiles.map((p) => [
      p.staff_id,
      computeLoadedCost({ ...p, vehicle_cost_per_hour: vehicleByStaff.get(p.staff_id) ?? 0 }).loadedHourlyRate,
    ])
  );
}

/**
 * Plant cost per usage entry, with the line it belongs to. Hours on equipment
 * assigned to a person are already in their labour rate, so only that
 * equipment's loads are costed; everything else is hours × cost per hour plus
 * loads × cost per load.
 */
export function plantCosts(
  usage: {
    equipment_id: string;
    hours: number;
    loads?: number | null;
    days?: number | null;
    cost_center_id?: string | null;
    /** The variation the office linked this usage to (0120 (draft)). */
    variation_id?: string | null;
  }[],
  equipment: EquipmentInput[]
): { cost: number; cost_center_id: string | null; variation_id: string | null }[] {
  const byId = new Map(equipment.map((e) => [e.id, e]));
  return usage
    .map((u) => {
      const eq = byId.get(u.equipment_id);
      const tags = { cost_center_id: u.cost_center_id ?? null, variation_id: u.variation_id ?? null };
      if (!eq) return { cost: 0, ...tags };
      return { cost: usageCost(u, eq), ...tags };
    })
    .filter((p) => p.cost > 0);
}

export interface LedgerInputs {
  costCentres: { id: string; name: string }[];
  /** The job's PO lines (po_cost_centers). */
  lines: { id: string; cost_centre_id?: string | null; allocated_amount: number | null; allocated_hours: number | null }[];
  /** Sum of the job's purchase_orders.total_value — the builder's price. */
  poTotal: number;
  timeEntries: { staff_id: string; hours: number | null; cost_center_id: string | null; entry_type?: string | null; variation_id?: string | null }[];
  ratesByStaff: Map<string, number>;
  /** variation_id: the variation the office linked it to (variation_cost_links, 0120 (draft)). */
  expenses: { amount: number | null; cost_center_id: string | null; variation_id?: string | null }[];
  supplierOrders: { amount: number | null; cost_center_id: string | null; status: string; variation_id?: string | null }[];
  plant: { cost: number; cost_center_id: string | null; variation_id?: string | null }[];
  /**
   * The job's variations (office/admin — they carry the price). Each gets its
   * own row when it has a price or a cost. Absent = none (and anything tagged
   * to a variation stays on its stage).
   */
  variations?: LedgerVariation[];
  /**
   * Mistakes (office/admin only), each on the PO line it was logged against:
   * manual (adds cost), linked (already in cost) and recovery received
   * (lib/mistake-costs.ts ledgerMistake). A 0115-only row passes amount_ex_gst,
   * counted as manual. Absent = none.
   */
  mistakes?: { cost_center_id: string | null; amount_ex_gst?: number | null; manual?: number; linked?: number; recovered?: number }[];
}

export interface LedgerVariation {
  id: string;
  name: string;
  status: string;
  rate?: number | string | null;
  quantity?: number | string | null;
  total_amount?: number | string | null;
}

/** A variation's price (ex GST): approved or auto-approved only — total_amount, else rate × quantity. */
export function variationRevenue(v: Pick<LedgerVariation, "status" | "rate" | "quantity" | "total_amount">): number {
  if (v.status !== "approved" && v.status !== "auto_approved") return 0;
  if (v.total_amount != null && v.total_amount !== "") return Number(v.total_amount) || 0;
  if (v.rate != null && v.rate !== "") return round((Number(v.rate) || 0) * (Number(v.quantity ?? 0) || 0));
  return 0;
}

/** The row key of a variation's own ledger row. */
export const variationRowKey = (id: string) => `variation:${id}`;

export interface LedgerRow {
  /** cost_centres.id, or "untagged" / "travel", or variationRowKey(id) for a variation. */
  key: string;
  /** A variation's own row (0120 (draft)): budget = its price, cost = the time and costs tagged to it. */
  variation?: { id: string; status: string; priced: boolean };
  name: string;
  budget: number;
  budgetHours: number;
  hours: number;
  labour: number;
  materials: number;
  plant: number;
  /** What mistakes on this cost centre cost (ex GST) — linked and manual; shown as part of cost. */
  mistakes: number;
  /** What mistakes ADD to cost here: manual lines less recovery received (linked lines are already counted). */
  mistakesAdded: number;
  cost: number;
  /** Supplier orders on this cost centre with no amount yet. */
  unpricedOrders: number;
}

export interface JobLedger {
  rows: LedgerRow[];
  budget: number;
  cost: number;
  /** Mistakes across the job (linked + manual) — a subset of `cost`. */
  mistakes: number;
  /** What mistakes add to the job's cost: manual lines less recovery received. Already inside `cost`. */
  mistakesAdded: number;
  /** Approved variations' prices — already inside `budget`. */
  variationRevenue: number;
  /** Cost tagged to variations (their rows) — already inside `cost`. */
  variationCost: number;
  margin: number;
  /** null with no budget. */
  marginPct: number | null;
  /** Part of the builder's PO value not split across cost centres. */
  unsplit: number;
  /** Hours by people with no rate on file — costed at $0, so cost is understated. */
  uncostedHours: number;
  unpricedOrders: number;
}

const round = (n: number) => Math.round(n * 100) / 100;

export function computeJobLedger(i: LedgerInputs): JobLedger {
  const lineCentre = new Map(i.lines.map((l) => [l.id, l.cost_centre_id ?? null]));
  const centreName = new Map(i.costCentres.map((c) => [c.id, c.name]));
  const rows = new Map<string, LedgerRow>();
  const row = (key: string, name: string): LedgerRow => {
    let r = rows.get(key);
    if (!r) {
      r = { key, name, budget: 0, budgetHours: 0, hours: 0, labour: 0, materials: 0, plant: 0, mistakes: 0, mistakesAdded: 0, cost: 0, unpricedOrders: 0 };
      rows.set(key, r);
    }
    return r;
  };
  // A line's cost centre, or "Not tagged" for a missing line or an untagged one.
  const forLine = (lineId: string | null) => {
    const centre = lineId ? lineCentre.get(lineId) ?? null : null;
    return centre ? row(centre, centreName.get(centre) ?? "Cost centre") : row("untagged", "Not tagged to a cost centre");
  };
  // A variation's own row (not rejected, and passed in), else the line's.
  const variations = new Map((i.variations ?? []).filter((v) => v.status !== "rejected").map((v) => [v.id, v]));
  const forVariation = (v: LedgerVariation) => {
    const r = row(variationRowKey(v.id), v.name);
    r.variation = { id: v.id, status: v.status, priced: v.status === "approved" || v.status === "auto_approved" };
    return r;
  };
  const forCost = (lineId: string | null, variationId: string | null | undefined) => {
    const v = variationId ? variations.get(variationId) : undefined;
    return v ? forVariation(v) : forLine(lineId);
  };
  let variationRevenueTotal = 0;
  for (const v of variations.values()) {
    const price = variationRevenue(v);
    variationRevenueTotal += price;
    if (price > 0) forVariation(v).budget += price;
  }

  for (const l of i.lines) {
    const r = l.cost_centre_id ? row(l.cost_centre_id, centreName.get(l.cost_centre_id) ?? "Cost centre") : row("untagged", "Not tagged to a cost centre");
    r.budget += Number(l.allocated_amount ?? 0);
    r.budgetHours += Number(l.allocated_hours ?? 0);
  }

  let uncostedHours = 0;
  for (const t of i.timeEntries) {
    const hours = Number(t.hours ?? 0);
    if (!hours) continue;
    const rate = i.ratesByStaff.get(t.staff_id) ?? 0;
    if (rate === 0) uncostedHours += hours;
    const r = t.entry_type === "travel" ? row("travel", "Travel") : forCost(t.cost_center_id, t.variation_id);
    r.hours += hours;
    r.labour += hours * rate;
  }

  for (const e of i.expenses) forCost(e.cost_center_id, e.variation_id).materials += Number(e.amount ?? 0);

  for (const o of i.supplierOrders) {
    if (o.status === "cancelled") continue;
    const r = forCost(o.cost_center_id, o.variation_id);
    const amount = Number(o.amount ?? 0);
    if (amount > 0) r.materials += amount;
    else r.unpricedOrders += 1;
  }

  for (const p of i.plant) forCost(p.cost_center_id, p.variation_id).plant += p.cost;

  for (const m of i.mistakes ?? []) {
    const manual = m.manual !== undefined ? Number(m.manual) || 0 : Math.max(0, Number(m.amount_ex_gst ?? 0) || 0);
    const linked = Number(m.linked ?? 0) || 0;
    const recovered = Number(m.recovered ?? 0) || 0;
    if (!manual && !linked && !recovered) continue;
    const r = forLine(m.cost_center_id);
    r.mistakes += manual + linked;
    r.mistakesAdded += manual - recovered;
  }

  // Company cost centres first in list order, then variations (in the order
  // given), then travel, then untagged.
  const variationOrder = new Map((i.variations ?? []).map((v, idx) => [variationRowKey(v.id), idx]));
  const order = (k: string) => {
    if (k === "travel") return 1e6;
    if (k === "untagged") return 1e6 + 1;
    const vIdx = variationOrder.get(k);
    if (vIdx !== undefined) return 5e5 + vIdx;
    const idx = i.costCentres.findIndex((c) => c.id === k);
    return idx === -1 ? 1e5 : idx;
  };
  const out = [...rows.values()]
    .map((r) => ({
      ...r,
      budget: round(r.budget),
      budgetHours: round(r.budgetHours),
      hours: round(r.hours),
      labour: round(r.labour),
      materials: round(r.materials),
      plant: round(r.plant),
      mistakes: round(r.mistakes),
      mistakesAdded: round(r.mistakesAdded),
      cost: round(r.labour + r.materials + r.plant + r.mistakesAdded),
    }))
    .sort((a, b) => order(a.key) - order(b.key));

  const budget = round(i.poTotal + variationRevenueTotal);
  const cost = round(out.reduce((s, r) => s + r.cost, 0));
  // The builder's PO value against its split: variation prices are their own rows' budgets.
  const split = out.filter((r) => !r.variation).reduce((s, r) => s + r.budget, 0);
  const variationCost = round(out.filter((r) => r.variation).reduce((s, r) => s + r.cost, 0));
  return {
    rows: out,
    budget,
    cost,
    mistakes: round(out.reduce((s, r) => s + r.mistakes, 0)),
    mistakesAdded: round(out.reduce((s, r) => s + r.mistakesAdded, 0)),
    variationRevenue: round(variationRevenueTotal),
    variationCost,
    margin: round(budget - cost),
    marginPct: budget > 0 ? round(((budget - cost) / budget) * 100) : null,
    unsplit: round(i.poTotal - split),
    uncostedHours: round(uncostedHours),
    unpricedOrders: out.reduce((s, r) => s + r.unpricedOrders, 0),
  };
}

/**
 * The flag: the job has already spent so much that, even with nothing more to
 * come, it can no longer make the minimum margin.
 */
export function belowMinimumMargin(ledger: Pick<JobLedger, "budget" | "marginPct">, minMarginPct: number): boolean {
  return ledger.budget > 0 && ledger.marginPct !== null && ledger.marginPct < minMarginPct;
}

/**
 * One cost centre's margin as a % of its own budget (Justin, 16 Nov 2026:
 * "we need a margin for each cost centre" — below ground and above ground
 * kept apart even when several POs share the job). null with no budget.
 */
export function rowMarginPct(r: Pick<LedgerRow, "budget" | "cost">): number | null {
  return r.budget > 0 ? round(((r.budget - r.cost) / r.budget) * 100) : null;
}

/** A cost centre's row is under the minimum margin (only rows with a budget). */
export function rowBelowMinimum(r: Pick<LedgerRow, "budget" | "cost">, minMarginPct: number): boolean {
  const pct = rowMarginPct(r);
  return pct !== null && pct < minMarginPct;
}

export interface CostCentreTotal {
  key: string;
  name: string;
  budget: number;
  cost: number;
  /** Mistakes (linked + manual) — a subset of `cost`. */
  mistakes: number;
  margin: number;
  marginPct: number | null;
}

/**
 * The same cost centre added up across several jobs' ledgers, in first-seen
 * order. Every job's variation rows add up into one "Variations" row.
 */
export function costCentreTotals(ledgers: Pick<JobLedger, "rows">[]): CostCentreTotal[] {
  const totals = new Map<string, { key: string; name: string; budget: number; cost: number; mistakes: number }>();
  for (const l of ledgers) {
    for (const r of l.rows) {
      const key = r.variation ? "variations" : r.key;
      const name = r.variation ? "Variations" : r.name;
      const t = totals.get(key) ?? { key, name, budget: 0, cost: 0, mistakes: 0 };
      t.budget += r.budget;
      t.cost += r.cost;
      t.mistakes += r.mistakes ?? 0;
      totals.set(key, t);
    }
  }
  return [...totals.values()].map((t) => {
    const budget = round(t.budget);
    const cost = round(t.cost);
    return { ...t, budget, cost, mistakes: round(t.mistakes), margin: round(budget - cost), marginPct: rowMarginPct({ budget, cost }) };
  });
}
