// Shared "true cost" math for a piece of equipment/vehicle, mirroring
// lib/staff-cost.ts's computeLoadedCost for staff. Used by the Fleet cost
// editor (components/fleet/equipment-cost-dialog.tsx) for a live preview,
// and by job costing (components/job/job-equipment.tsx and
// components/job/job-profitability.tsx) to price logged equipment hours
// against a job. Kept in one place so all three never drift apart.

export interface EquipmentCostInputs {
  purchase_cost: number;
  estimated_life_years: number;
  insurance_annual: number;
  maintenance_annual: number;
  registration_annual: number;
  other_annual_costs: number;
  fuel_cost_per_hour: number;
  target_hours_per_year: number;
}

export interface EquipmentCostResult {
  annualDepreciation: number;
  annualFixedCost: number;
  annualFuelCost: number;
  annualTotalCost: number;
  costPerHour: number;
}

// Straight-line depreciation (purchase_cost / life) plus insurance,
// maintenance, registration and other annual fixed costs, spread across
// target_hours_per_year to get a $/hour figure -- then fuel (already a
// $/hour input) is added on top of that so costPerHour reflects "what it
// actually costs to run this thing for an hour," fixed + variable.
export function computeEquipmentCost(inputs: EquipmentCostInputs): EquipmentCostResult {
  const lifeYears = Number(inputs.estimated_life_years || 0);
  const annualDepreciation = lifeYears > 0 ? Number(inputs.purchase_cost || 0) / lifeYears : 0;
  const annualFixedCost =
    annualDepreciation +
    Number(inputs.insurance_annual || 0) +
    Number(inputs.maintenance_annual || 0) +
    Number(inputs.registration_annual || 0) +
    Number(inputs.other_annual_costs || 0);
  const targetHours = Number(inputs.target_hours_per_year || 0);
  const annualFuelCost = Number(inputs.fuel_cost_per_hour || 0) * targetHours;
  const annualTotalCost = annualFixedCost + annualFuelCost;
  const costPerHour = targetHours > 0 ? annualTotalCost / targetHours : 0;
  return { annualDepreciation, annualFixedCost, annualFuelCost, annualTotalCost, costPerHour };
}

export const EQUIPMENT_CATEGORY_LABELS: Record<string, string> = {
  vehicle: "Vehicle",
  machinery: "Machinery",
  tool: "Tool",
  other: "Other",
};
