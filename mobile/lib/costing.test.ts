import { computeLoadedCost, computeEquipmentCost, computeJobProfitability } from "./costing";
import type { JobProfitabilityInput } from "./costing";

describe("computeLoadedCost", () => {
  it("loads the base wage by on-costs + fixed oncosts over annual paid hours", () => {
    const r = computeLoadedCost({
      hourly_rate: 50, target_hours_per_week: 38, super_rate: 11, workers_comp_rate: 2, leave_loading_rate: 0, annual_fixed_oncosts: 1000,
    });
    expect(r.annualPaidHours).toBe(1976); // 38 * 52
    // 50*1976*1.13 + 1000 = 112644 ; /1976
    expect(r.annualLoadedCost).toBeCloseTo(112644, 5);
    expect(r.loadedHourlyRate).toBeCloseTo(57.006072874, 6);
  });

  it("folds an assigned vehicle's $/hour into the loaded rate", () => {
    const base = { hourly_rate: 40, target_hours_per_week: 40, super_rate: 0, workers_comp_rate: 0, leave_loading_rate: 0, annual_fixed_oncosts: 0 };
    expect(computeLoadedCost(base).loadedHourlyRate).toBe(40); // no vehicle
    expect(computeLoadedCost({ ...base, vehicle_cost_per_hour: 10 }).loadedHourlyRate).toBe(50); // +10/h vehicle
  });

  it("returns a 0 rate when there are no paid hours (avoids divide-by-zero)", () => {
    expect(computeLoadedCost({ hourly_rate: 50, target_hours_per_week: 0, super_rate: 0, workers_comp_rate: 0, leave_loading_rate: 0, annual_fixed_oncosts: 0 }).loadedHourlyRate).toBe(0);
  });
});

describe("computeEquipmentCost", () => {
  it("spreads straight-line depreciation + fixed costs over target hours, plus fuel", () => {
    const r = computeEquipmentCost({
      purchase_cost: 60000, estimated_life_years: 10, insurance_annual: 2000, maintenance_annual: 3000, registration_annual: 1000, other_annual_costs: 0, fuel_cost_per_hour: 8, target_hours_per_year: 1000,
    });
    expect(r.annualDepreciation).toBe(6000);
    expect(r.annualFixedCost).toBe(12000);
    expect(r.annualFuelCost).toBe(8000);
    expect(r.costPerHour).toBe(20); // 20000 / 1000
  });

  it("returns a 0 cost/hour when there are no target hours", () => {
    expect(computeEquipmentCost({ purchase_cost: 1, estimated_life_years: 1, insurance_annual: 0, maintenance_annual: 0, registration_annual: 0, other_annual_costs: 0, fuel_cost_per_hour: 0, target_hours_per_year: 0 }).costPerHour).toBe(0);
  });
});

describe("computeJobProfitability", () => {
  // S1 loaded rate resolves to 50/h once its assigned vehicle EQ1 (10/h) folds in.
  // S2 has no cost profile → 0/h (uncosted). EQ2 (20/h) is unassigned/shared.
  const baseInput: JobProfitabilityInput = {
    timeEntries: [
      { staff_id: "s1", hours: 10 },
      { staff_id: "s2", hours: 4 }, // uncosted
    ],
    staffCostProfiles: [
      { staff_id: "s1", hourly_rate: 40, target_hours_per_week: 40, super_rate: 0, workers_comp_rate: 0, leave_loading_rate: 0, annual_fixed_oncosts: 0 },
    ],
    expenses: [{ amount: 100 }, { amount: 50 }],
    equipmentUsage: [
      { equipment_id: "eq1", hours: 5 }, // assigned to s1 → excluded (already in labour)
      { equipment_id: "eq2", hours: 3 }, // unassigned → costed
    ],
    equipmentOptions: [
      { id: "eq1", assigned_to: "s1", purchase_cost: 0, estimated_life_years: 0, insurance_annual: 0, maintenance_annual: 0, registration_annual: 0, other_annual_costs: 0, fuel_cost_per_hour: 10, target_hours_per_year: 100 }, // 10/h
      { id: "eq2", assigned_to: null, purchase_cost: 60000, estimated_life_years: 10, insurance_annual: 2000, maintenance_annual: 3000, registration_annual: 1000, other_annual_costs: 0, fuel_cost_per_hour: 8, target_hours_per_year: 1000 }, // 20/h
    ],
    invoices: [
      { subtotal: 1000, status: "sent" },
      { subtotal: 500, status: "cancelled" }, // excluded from revenue
    ],
    jobItems: [{ total: 800 }, { total: null }],
    variations: [
      { status: "approved", invoice_id: null, total_amount: 200 }, // counted
      { status: "approved", invoice_id: "inv1", total_amount: 999 }, // already billed → excluded
      { status: "pending", invoice_id: null, total_amount: 50 }, // not approved → excluded
      { status: "auto_approved", invoice_id: null, total_amount: 100 }, // counted
    ],
    minMarginPct: 30,
  };

  it("rolls up labour, materials and (unassigned) equipment into total cost", () => {
    const r = computeJobProfitability(baseInput);
    expect(r.labourCost).toBe(500); // 10h * 50/h (s2 uncosted → 0)
    expect(r.labourHours).toBe(14);
    expect(r.materialsCost).toBe(150);
    expect(r.equipmentCost).toBe(60); // eq2: 3h * 20/h (eq1 excluded)
    expect(r.excludedEquipmentUsageCount).toBe(1);
    expect(r.equipmentUsageCount).toBe(1);
    expect(r.totalCost).toBe(710);
  });

  it("surfaces uncosted labour (staff with no wage on file) instead of hiding it", () => {
    const r = computeJobProfitability(baseInput);
    expect(r.uncostedHours).toBe(4);
    expect(r.uncostedStaffCount).toBe(1);
  });

  it("computes actual margin from non-cancelled invoice subtotals", () => {
    const r = computeJobProfitability(baseInput);
    expect(r.revenue).toBe(1000); // cancelled 500 excluded
    expect(r.margin).toBe(290);
    expect(r.marginPct).toBeCloseTo(29, 6);
  });

  it("computes projected margin from built-up items + unbilled approved variations", () => {
    const r = computeJobProfitability(baseInput);
    expect(r.projectedRevenue).toBe(1100); // 800 items + (200 + 100) variations
    expect(r.projectedMargin).toBe(390);
    expect(r.projectedMarginPct).toBeCloseTo(35.4545, 3);
    expect(r.belowMinMargin).toBe(false); // 35.45% >= 30%
  });

  it("flags below-minimum margin against the configured threshold", () => {
    expect(computeJobProfitability({ ...baseInput, minMarginPct: 40 }).belowMinMargin).toBe(true); // 35.45% < 40%
  });

  it("returns null margin percentages when there is no revenue (avoids divide-by-zero)", () => {
    const r = computeJobProfitability({ ...baseInput, invoices: [], jobItems: [], variations: [] });
    expect(r.revenue).toBe(0);
    expect(r.marginPct).toBeNull();
    expect(r.projectedRevenue).toBe(0);
    expect(r.projectedMarginPct).toBeNull();
    expect(r.belowMinMargin).toBe(false);
  });
});
