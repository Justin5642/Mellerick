import { computeLoadedCost } from "@/lib/staff-cost";
import { computeEquipmentCost, type EquipmentCostInputs } from "@/lib/equipment-cost";

// The job ledger (Stage 3 of the 31 Oct 2026 workflow review): for one job,
// per company cost centre, the budget from the builder's PO split (Stage 2)
// against what the job has cost so far — labour, materials, plant — and the
// margin that leaves. Justin: "I can see live margin and whether a job is
// worth doing. Pricing is getting lean, so this is a priority."
//
// Pure, so the job's Costing tab and the open-jobs list compute it the same
// way. Everything is ex GST. Costing follows the Costing tab's existing rules
// (lib/staff-cost.ts loaded rates, lib/equipment-cost.ts plant rates, and the
// vehicle double-count guard), now split by cost centre:
//
//   budget     po_cost_centers.allocated_amount, by cost_centre_id (0087)
//   labour     work hours × the person's loaded rate, by the entry's line
//   travel     travel hours × loaded rate — its own row, it has no line
//   materials  job_expenses + priced supplier orders, by line. A supplier
//              order with no amount yet is counted as "to be priced", not $0.
//   plant      equipment usage × cost per hour. Usage has no cost centre yet,
//              so it lands in "Not tagged".
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
}

/** Each person's loaded $/hour, with any vehicle assigned to them folded in. */
export function loadedRatesByStaff(profiles: StaffCostProfileInput[], equipment: EquipmentInput[]): Map<string, number> {
  const vehicleByStaff = new Map<string, number>();
  for (const eq of equipment) {
    if (!eq.assigned_to) continue;
    vehicleByStaff.set(eq.assigned_to, (vehicleByStaff.get(eq.assigned_to) ?? 0) + computeEquipmentCost(eq).costPerHour);
  }
  return new Map(
    profiles.map((p) => [
      p.staff_id,
      computeLoadedCost({ ...p, vehicle_cost_per_hour: vehicleByStaff.get(p.staff_id) ?? 0 }).loadedHourlyRate,
    ])
  );
}

/** Plant cost per usage entry. Equipment assigned to a person is already in their labour rate, so it is skipped. */
export function plantCosts(usage: { equipment_id: string; hours: number }[], equipment: EquipmentInput[]): number[] {
  const byId = new Map(equipment.map((e) => [e.id, e]));
  return usage
    .filter((u) => !byId.get(u.equipment_id)?.assigned_to)
    .map((u) => {
      const eq = byId.get(u.equipment_id);
      return eq ? Number(u.hours) * computeEquipmentCost(eq).costPerHour : 0;
    });
}

export interface LedgerInputs {
  costCentres: { id: string; name: string }[];
  /** The job's PO lines (po_cost_centers). */
  lines: { id: string; cost_centre_id?: string | null; allocated_amount: number | null; allocated_hours: number | null }[];
  /** Sum of the job's purchase_orders.total_value — the builder's price. */
  poTotal: number;
  timeEntries: { staff_id: string; hours: number | null; cost_center_id: string | null; entry_type?: string | null }[];
  ratesByStaff: Map<string, number>;
  expenses: { amount: number | null; cost_center_id: string | null }[];
  supplierOrders: { amount: number | null; cost_center_id: string | null; status: string }[];
  plant: number[];
}

export interface LedgerRow {
  /** cost_centres.id, or "untagged" / "travel". */
  key: string;
  name: string;
  budget: number;
  budgetHours: number;
  hours: number;
  labour: number;
  materials: number;
  plant: number;
  cost: number;
  /** Supplier orders on this cost centre with no amount yet. */
  unpricedOrders: number;
}

export interface JobLedger {
  rows: LedgerRow[];
  budget: number;
  cost: number;
  margin: number;
  /** null with no budget. */
  marginPct: number | null;
  /** Part of the PO value not split across cost centres. */
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
      r = { key, name, budget: 0, budgetHours: 0, hours: 0, labour: 0, materials: 0, plant: 0, cost: 0, unpricedOrders: 0 };
      rows.set(key, r);
    }
    return r;
  };
  // A line's cost centre, or "Not tagged" for a missing line or an untagged one.
  const forLine = (lineId: string | null) => {
    const centre = lineId ? lineCentre.get(lineId) ?? null : null;
    return centre ? row(centre, centreName.get(centre) ?? "Cost centre") : row("untagged", "Not tagged to a cost centre");
  };

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
    const r = t.entry_type === "travel" ? row("travel", "Travel") : forLine(t.cost_center_id);
    r.hours += hours;
    r.labour += hours * rate;
  }

  for (const e of i.expenses) forLine(e.cost_center_id).materials += Number(e.amount ?? 0);

  for (const o of i.supplierOrders) {
    if (o.status === "cancelled") continue;
    const r = forLine(o.cost_center_id);
    const amount = Number(o.amount ?? 0);
    if (amount > 0) r.materials += amount;
    else r.unpricedOrders += 1;
  }

  const plantTotal = i.plant.reduce((s, p) => s + p, 0);
  if (plantTotal > 0) row("untagged", "Not tagged to a cost centre").plant += plantTotal;

  // Company cost centres first in list order, then travel, then untagged.
  const order = (k: string) => {
    if (k === "travel") return 1e6;
    if (k === "untagged") return 1e6 + 1;
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
      cost: round(r.labour + r.materials + r.plant),
    }))
    .sort((a, b) => order(a.key) - order(b.key));

  const budget = round(i.poTotal);
  const cost = round(out.reduce((s, r) => s + r.cost, 0));
  const split = out.reduce((s, r) => s + r.budget, 0);
  return {
    rows: out,
    budget,
    cost,
    margin: round(budget - cost),
    marginPct: budget > 0 ? round(((budget - cost) / budget) * 100) : null,
    unsplit: round(budget - split),
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
