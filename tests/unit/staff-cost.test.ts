import { describe, it, expect } from "vitest";
import { computeLoadedCost, type StaffCostInputs } from "@/lib/staff-cost";

// Characterization tests: lock in the fully-loaded staff cost math (annual
// wage * on-cost multiplier + fixed on-costs + vehicle, over annual paid
// hours). Feeds apprentice bill rates and the Reports efficiency section.

const base: StaffCostInputs = {
  hourly_rate: 40,
  super_rate: 11,
  workers_comp_rate: 4,
  leave_loading_rate: 0,
  annual_fixed_oncosts: 2000,
  target_hours_per_week: 38,
};

describe("computeLoadedCost", () => {
  it("computes annual paid hours across 52 weeks", () => {
    const r = computeLoadedCost(base);
    expect(r.annualPaidHours).toBe(38 * 52); // 1976
  });

  it("applies super + workers-comp + leave-loading as a percentage on-cost multiplier", () => {
    const r = computeLoadedCost(base);
    const annualPaidHours = 1976;
    const baseWage = 40 * annualPaidHours; // 79040
    const multiplier = 1 + (11 + 4 + 0) / 100; // 1.15
    const expectedAnnual = baseWage * multiplier + 2000; // + fixed on-costs, no vehicle
    expect(r.annualLoadedCost).toBeCloseTo(expectedAnnual, 6);
    expect(r.loadedHourlyRate).toBeCloseTo(expectedAnnual / annualPaidHours, 6);
  });

  it("adds assigned vehicle cost per hour into the annual loaded cost", () => {
    const withVehicle = computeLoadedCost({ ...base, vehicle_cost_per_hour: 10 });
    const without = computeLoadedCost(base);
    // vehicle adds 10 * annualPaidHours to the annual cost
    expect(withVehicle.annualVehicleCost).toBe(10 * 1976);
    expect(withVehicle.annualLoadedCost - without.annualLoadedCost).toBeCloseTo(10 * 1976, 6);
  });

  it("returns zero loaded hourly rate when there are no paid hours", () => {
    const r = computeLoadedCost({ ...base, target_hours_per_week: 0 });
    expect(r.annualPaidHours).toBe(0);
    expect(r.loadedHourlyRate).toBe(0);
    expect(Number.isNaN(r.loadedHourlyRate)).toBe(false);
  });
});
