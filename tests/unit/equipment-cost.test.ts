import { describe, it, expect } from "vitest";
import { computeEquipmentCost, type EquipmentCostInputs } from "@/lib/equipment-cost";

// Characterization tests: lock in the current true-cost math for a vehicle/
// piece of equipment (straight-line depreciation + annual fixed costs spread
// over target hours, then fuel added per hour). Shared by the fleet cost
// editor and job profitability, so a regression here mis-prices jobs.

const base: EquipmentCostInputs = {
  purchase_cost: 60000,
  estimated_life_years: 10,
  insurance_annual: 2000,
  maintenance_annual: 3000,
  registration_annual: 1000,
  other_annual_costs: 0,
  fuel_cost_per_hour: 5,
  target_hours_per_year: 1000,
};

describe("computeEquipmentCost", () => {
  it("computes straight-line depreciation, fixed cost, fuel and cost/hour", () => {
    const r = computeEquipmentCost(base);
    expect(r.annualDepreciation).toBe(6000); // 60000 / 10
    expect(r.annualFixedCost).toBe(12000); // 6000 + 2000 + 3000 + 1000 + 0
    expect(r.annualFuelCost).toBe(5000); // 5 * 1000
    expect(r.annualTotalCost).toBe(17000); // 12000 + 5000
    expect(r.costPerHour).toBe(17); // 17000 / 1000
  });

  it("returns zero depreciation when life is zero (avoids divide-by-zero)", () => {
    const r = computeEquipmentCost({ ...base, estimated_life_years: 0 });
    expect(r.annualDepreciation).toBe(0);
    expect(r.annualFixedCost).toBe(6000); // fixed costs only, no depreciation
  });

  it("returns zero cost/hour when target hours is zero", () => {
    const r = computeEquipmentCost({ ...base, target_hours_per_year: 0 });
    expect(r.costPerHour).toBe(0);
    expect(r.annualFuelCost).toBe(0); // fuel is per-hour * hours = 0
  });

  it("coerces nullish numeric fields to zero rather than producing NaN", () => {
    const r = computeEquipmentCost({
      purchase_cost: undefined as unknown as number,
      estimated_life_years: undefined as unknown as number,
      insurance_annual: undefined as unknown as number,
      maintenance_annual: undefined as unknown as number,
      registration_annual: undefined as unknown as number,
      other_annual_costs: undefined as unknown as number,
      fuel_cost_per_hour: undefined as unknown as number,
      target_hours_per_year: undefined as unknown as number,
    });
    expect(r.annualTotalCost).toBe(0);
    expect(r.costPerHour).toBe(0);
    expect(Number.isNaN(r.costPerHour)).toBe(false);
  });
});
