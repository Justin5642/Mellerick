// Fleet cost over a year, and the cost rate job costing uses.
//
// Pure: no database. lib/fleet-rates.ts loads the rows.
//
// TWO NUMBERS, and why (Justin, 14 Nov 2026 — "use real logged expenses instead
// of estimates"):
//
//   estimate  lib/equipment-cost.ts: the cost profile someone typed in
//             (purchase price / life, insurance, maintenance, rego, fuel/hr)
//             spread over TARGET hours. What every job was costed at until now.
//   actual    what the machine really cost over the last 12 months — that
//             period's depreciation plus every expense logged against it in
//             Fleet — divided by the hours it ACTUALLY worked in the same 12
//             months. A truck that sat idle, or needed a $9,000 gearbox, now
//             shows up in the cost of the jobs it did.
//
// The actual rate is used once there is enough to divide by (MIN_ACTUAL_HOURS
// and at least one logged expense); before that, the estimate, labelled as such.

import { computeEquipmentCost, type EquipmentCostInputs } from "@/lib/equipment-cost";

export const EXPENSE_CATEGORIES = ["service", "repair", "fuel", "tyres", "registration", "insurance", "other"] as const;
export type ExpenseCategory = (typeof EXPENSE_CATEGORIES)[number];

export const EXPENSE_CATEGORY_LABELS: Record<string, string> = {
  service: "Service",
  repair: "Repair",
  fuel: "Fuel",
  tyres: "Tyres",
  registration: "Registration",
  insurance: "Insurance",
  other: "Other",
};

export interface FleetExpense {
  equipment_id?: string;
  category: string;
  amount: number | string; // ex GST
  gst_amount?: number | string | null;
  expense_date: string; // YYYY-MM-DD
}

// ---------------------------------------------------------------------------
// Financial years (Australia: 1 July – 30 June)
// ---------------------------------------------------------------------------

export interface Period {
  label: string;
  /** Inclusive YYYY-MM-DD. */
  start: string;
  /** Inclusive YYYY-MM-DD. */
  end: string;
}

/** The financial year a date falls in. `startYear` 2026 = FY 2026–27. */
export function financialYear(startYear: number): Period {
  return {
    label: `FY ${startYear}–${String((startYear + 1) % 100).padStart(2, "0")}`,
    start: `${startYear}-07-01`,
    end: `${startYear + 1}-06-30`,
  };
}

export function financialYearStartOf(dateKey: string): number {
  const [y, m] = dateKey.split("-").map(Number);
  return m >= 7 ? y : y - 1;
}

/** Financial years from the earliest date given up to the one containing `today`, newest first. */
export function financialYearsSince(dateKeys: string[], today: string): Period[] {
  const current = financialYearStartOf(today);
  const earliest = dateKeys.length ? Math.min(...dateKeys.map(financialYearStartOf)) : current;
  const years: Period[] = [];
  for (let y = current; y >= Math.min(earliest, current); y--) years.push(financialYear(y));
  return years;
}

const inPeriod = (dateKey: string, p: Pick<Period, "start" | "end">) => dateKey >= p.start && dateKey <= p.end;

// ---------------------------------------------------------------------------
// Cost summary
// ---------------------------------------------------------------------------

export interface CostSummary {
  byCategory: Record<string, { exGst: number; gst: number; count: number }>;
  totalExGst: number;
  totalGst: number;
  count: number;
  /** YYYY-MM -> ex GST, every month of the period present (zeros included). */
  byMonth: { month: string; exGst: number }[];
}

const cents = (n: number) => Math.round(n * 100) / 100;

function monthsOf(p: Pick<Period, "start" | "end">): string[] {
  const out: string[] = [];
  let [y, m] = p.start.split("-").map(Number);
  const [ey, em] = p.end.split("-").map(Number);
  while (y < ey || (y === ey && m <= em)) {
    out.push(`${y}-${String(m).padStart(2, "0")}`);
    m += 1;
    if (m > 12) { m = 1; y += 1; }
    if (out.length > 240) break;
  }
  return out;
}

export function summariseExpenses(expenses: FleetExpense[], period: Pick<Period, "start" | "end">): CostSummary {
  const byCategory: CostSummary["byCategory"] = {};
  const byMonth = new Map(monthsOf(period).map((k) => [k, 0]));
  let totalExGst = 0;
  let totalGst = 0;
  let count = 0;
  for (const e of expenses) {
    if (!inPeriod(e.expense_date, period)) continue;
    const ex = Number(e.amount) || 0;
    const gst = Number(e.gst_amount) || 0;
    const c = (byCategory[e.category] ??= { exGst: 0, gst: 0, count: 0 });
    c.exGst += ex;
    c.gst += gst;
    c.count += 1;
    totalExGst += ex;
    totalGst += gst;
    count += 1;
    const month = e.expense_date.slice(0, 7);
    if (byMonth.has(month)) byMonth.set(month, (byMonth.get(month) ?? 0) + ex);
  }
  for (const c of Object.values(byCategory)) {
    c.exGst = cents(c.exGst);
    c.gst = cents(c.gst);
  }
  return {
    byCategory,
    totalExGst: cents(totalExGst),
    totalGst: cents(totalGst),
    count,
    byMonth: [...byMonth.entries()].map(([month, exGst]) => ({ month, exGst: cents(exGst) })),
  };
}

// ---------------------------------------------------------------------------
// Actual cost rate
// ---------------------------------------------------------------------------

/** Below this many hours worked in the window, the actual rate is too noisy to cost jobs with. */
export const MIN_ACTUAL_HOURS = 40;

export interface EffectiveRate {
  costPerHour: number;
  source: "actual" | "estimate";
  estimateCostPerHour: number;
  /** Why the estimate is being used, when it is. */
  reason: string | null;
  window: { start: string; end: string; days: number };
  actual: {
    hours: number;
    depreciation: number;
    expenses: number;
    /** Estimated fuel, added only when no fuel was logged in the window. */
    fuelEstimate: number;
    totalCost: number;
    costPerHour: number | null;
  };
}

export interface EffectiveRateInput {
  equipment: EquipmentCostInputs & { purchase_date?: string | null; created_at?: string | null };
  /** This equipment's expenses (any dates; filtered to the window here). */
  expenses: FleetExpense[];
  /**
   * Hours it worked in the window: logged usage for shared plant, or — for a
   * vehicle assigned to someone — that person's clocked work hours, which is
   * how assigned vehicles are already costed (lib/staff-cost.ts).
   */
  hoursWorked: number;
  /** Trailing window, inclusive YYYY-MM-DD; normally the last 12 months. */
  window: { start: string; end: string };
}

const dayMs = 86_400_000;
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / dayMs) + 1;

export function effectiveCostRate(input: EffectiveRateInput): EffectiveRate {
  const { equipment, hoursWorked, window } = input;
  const estimate = computeEquipmentCost(equipment);

  // Only count depreciation for the part of the window it was owned.
  const ownedFrom = (equipment.purchase_date ?? equipment.created_at ?? "").slice(0, 10);
  const start = ownedFrom && ownedFrom > window.start ? ownedFrom : window.start;
  const days = start > window.end ? 0 : Math.min(366, daysBetween(start, window.end));

  const inWindow = input.expenses.filter((e) => inPeriod(e.expense_date, { start, end: window.end }));
  const expenses = inWindow.reduce((s, e) => s + (Number(e.amount) || 0), 0);
  const fuelLogged = inWindow.some((e) => e.category === "fuel");
  const hours = Math.max(0, Number(hoursWorked) || 0);
  const depreciation = estimate.annualDepreciation * (days / 365);
  const fuelEstimate = fuelLogged ? 0 : Number(equipment.fuel_cost_per_hour || 0) * hours;
  const totalCost = depreciation + expenses + fuelEstimate;
  const actualRate = hours > 0 ? totalCost / hours : null;

  const reason =
    hours < MIN_ACTUAL_HOURS
      ? `only ${hours.toFixed(1)}h worked in the last 12 months (needs ${MIN_ACTUAL_HOURS}h)`
      : inWindow.length === 0
        ? "no expenses logged in the last 12 months"
        : null;
  const useActual = reason === null && actualRate !== null;

  return {
    costPerHour: cents(useActual ? actualRate! : estimate.costPerHour),
    source: useActual ? "actual" : "estimate",
    estimateCostPerHour: cents(estimate.costPerHour),
    reason,
    window: { start, end: window.end, days },
    actual: {
      hours: cents(hours),
      depreciation: cents(depreciation),
      expenses: cents(expenses),
      fuelEstimate: cents(fuelEstimate),
      totalCost: cents(totalCost),
      costPerHour: actualRate === null ? null : cents(actualRate),
    },
  };
}

/**
 * The $/hour to cost a piece of equipment at: the effective rate when the page
 * loaded one (lib/fleet-rates.ts attaches it), else the estimate. Every job
 * costing path goes through this so they cannot disagree.
 */
export function costPerHourOf(eq: EquipmentCostInputs & { effective_rate?: EffectiveRate | null }): number {
  return eq.effective_rate ? eq.effective_rate.costPerHour : computeEquipmentCost(eq).costPerHour;
}

/** The trailing 12-month window ending on `today` (inclusive). */
export function trailingYear(today: string): { start: string; end: string } {
  const [y, m, d] = today.split("-").map(Number);
  const start = new Date(Date.UTC(y - 1, m - 1, d + 1));
  return { start: start.toISOString().slice(0, 10), end: today };
}
