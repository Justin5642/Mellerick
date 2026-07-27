import { computeEquipmentCost, type EquipmentCostInputs } from "./costing";

// Equipment cost & utilisation, ported verbatim from the web Reports page. NOT
// payroll-sensitive (equipment is readable by office+admin), so it isn't
// admin-gated. True cost per hour used = fixed annual cost ÷ hours actually used
// + fuel/h, so low utilisation drives the effective $/hr above the budgeted rate.
export interface EquipUtilInput {
  equipment: (EquipmentCostInputs & { id: string; name: string })[];
  usage: { equipment_id: string; hours: number | null }[];
}
export interface EquipUtilRow {
  name: string;
  hoursUsed: number;
  budgetedCostPerHour: number;
  annualTotalCost: number;
  utilizationPct: number | null;
  trueCostPerHourUsed: number | null;
}

export function computeEquipmentUtilization(input: EquipUtilInput): EquipUtilRow[] {
  const hoursByEquip = new Map<string, number>();
  for (const u of input.usage) hoursByEquip.set(u.equipment_id, (hoursByEquip.get(u.equipment_id) ?? 0) + Number(u.hours ?? 0));

  return input.equipment
    .map((eq) => {
      const { costPerHour, annualFixedCost, annualTotalCost } = computeEquipmentCost(eq);
      const hoursUsed = hoursByEquip.get(eq.id) ?? 0;
      const targetHours = Number(eq.target_hours_per_year ?? 0);
      return {
        name: eq.name,
        hoursUsed,
        budgetedCostPerHour: costPerHour,
        annualTotalCost,
        utilizationPct: targetHours > 0 ? (hoursUsed / targetHours) * 100 : null,
        trueCostPerHourUsed: hoursUsed > 0 ? annualFixedCost / hoursUsed + Number(eq.fuel_cost_per_hour ?? 0) : null,
      };
    })
    .sort((a, b) => (b.trueCostPerHourUsed ?? 0) - (a.trueCostPerHourUsed ?? 0));
}
