// Loads what lib/fleet-costs.ts effectiveCostRate() needs and attaches the
// result to each equipment row as `effective_rate`. costPerHourOf() then reads
// it, so every job-costing path prices plant the same way.
//
// Reads are paged (lib/fetch-all-rows.ts): a truncated expense or usage read
// would quietly understate a machine's real cost, the exact error this exists
// to remove. If anything cannot be read the row keeps the estimate, and says
// why — it never shows a partial "actual".

import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchAllRows } from "@/lib/fetch-all-rows";
import { dateKeyInBusinessTZ } from "@/lib/date";
import { computeEquipmentCost, type EquipmentCostInputs } from "@/lib/equipment-cost";
import { effectiveCostRate, trailingYear, type EffectiveRate, type FleetExpense } from "@/lib/fleet-costs";

type EquipmentRow = EquipmentCostInputs & {
  id: string;
  assigned_to?: string | null;
  purchase_date?: string | null;
  created_at?: string | null;
};

/** Columns effectiveCostRate needs, for pages that select a column list. */
export const EFFECTIVE_RATE_COLUMNS =
  "id, assigned_to, purchase_date, created_at, purchase_cost, estimated_life_years, insurance_annual, maintenance_annual, " +
  "registration_annual, other_annual_costs, fuel_cost_per_hour, target_hours_per_year";

const chunks = <T,>(a: T[], n: number) => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));

function estimateOnly(eq: EquipmentRow, why: string, window: { start: string; end: string }): EffectiveRate {
  const est = Math.round(computeEquipmentCost(eq).costPerHour * 100) / 100;
  return {
    costPerHour: est,
    source: "estimate",
    estimateCostPerHour: est,
    reason: why,
    window: { ...window, days: 0 },
    actual: { hours: 0, depreciation: 0, expenses: 0, fuelEstimate: 0, totalCost: 0, costPerHour: null },
  };
}

export async function attachEffectiveRates<T extends EquipmentRow>(
  db: SupabaseClient,
  equipment: T[],
  today: string = dateKeyInBusinessTZ(new Date())
): Promise<Array<T & { effective_rate: EffectiveRate }>> {
  const window = trailingYear(today);
  if (equipment.length === 0) return [];
  const ids = equipment.map((e) => e.id);
  const staffIds = [...new Set(equipment.map((e) => e.assigned_to).filter((s): s is string => !!s))];

  try {
    const expenses: FleetExpense[] = [];
    const usageHours = new Map<string, number>();
    const staffHours = new Map<string, number>();

    for (const c of chunks(ids, 150)) {
      const exp = await fetchAllRows<FleetExpense>((count) =>
        db.from("equipment_expenses").select("equipment_id, category, amount, gst_amount, expense_date", count)
          .in("equipment_id", c).gte("expense_date", window.start).lte("expense_date", window.end).order("id") as never
      );
      if (!exp.ok) throw new Error(`expenses: ${exp.error}`);
      expenses.push(...exp.rows);

      const use = await fetchAllRows<{ equipment_id: string; hours: number }>((count) =>
        db.from("equipment_usage_log").select("equipment_id, hours", count)
          .in("equipment_id", c).gte("usage_date", window.start).lte("usage_date", window.end).order("id") as never
      );
      if (!use.ok) throw new Error(`usage log: ${use.error}`);
      for (const u of use.rows) usageHours.set(u.equipment_id, (usageHours.get(u.equipment_id) ?? 0) + (Number(u.hours) || 0));
    }

    for (const c of chunks(staffIds, 150)) {
      const te = await fetchAllRows<{ staff_id: string; clock_in: string; clock_out: string }>((count) =>
        db.from("time_entries").select("staff_id, clock_in, clock_out", count)
          .in("staff_id", c).eq("entry_type", "work").not("clock_out", "is", null)
          .gte("clock_in", `${window.start}T00:00:00Z`).order("id") as never
      );
      if (!te.ok) throw new Error(`time entries: ${te.error}`);
      for (const t of te.rows) {
        const h = (Date.parse(t.clock_out) - Date.parse(t.clock_in)) / 3_600_000;
        if (h > 0) staffHours.set(t.staff_id, (staffHours.get(t.staff_id) ?? 0) + h);
      }
    }

    const expensesBy = new Map<string, FleetExpense[]>();
    for (const e of expenses) {
      const list = expensesBy.get(e.equipment_id!) ?? [];
      list.push(e);
      expensesBy.set(e.equipment_id!, list);
    }

    return equipment.map((eq) => ({
      ...eq,
      effective_rate: effectiveCostRate({
        equipment: eq,
        expenses: expensesBy.get(eq.id) ?? [],
        // An assigned vehicle works when its driver works (it is costed through
        // their hourly rate); shared plant works when someone logs it.
        hoursWorked: eq.assigned_to ? staffHours.get(eq.assigned_to) ?? 0 : usageHours.get(eq.id) ?? 0,
        window,
      }),
    }));
  } catch (e: any) {
    const why = `actual costs could not be loaded (${e.message ?? "unknown error"})`;
    return equipment.map((eq) => ({ ...eq, effective_rate: estimateOnly(eq, why, window) }));
  }
}
