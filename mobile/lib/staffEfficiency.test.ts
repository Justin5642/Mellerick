import { computeStaffEfficiency, type StaffEffInput } from "./staffEfficiency";

// S1 profile: $40/h base, 40h/wk (annualPaidHours 2080), no on-costs. With its
// assigned vehicle EQ1 ($10/h) folded in, its loaded rate is $50/h and its
// annual loaded cost is 40*2080 + 10*2080 = 104000 (see costing.test.ts).
const baseInput: StaffEffInput = {
  profiles: [
    { staff_id: "s1", hourly_rate: 40, target_hours_per_week: 40, super_rate: 0, workers_comp_rate: 0, leave_loading_rate: 0, annual_fixed_oncosts: 0 },
    { staff_id: "s2", hourly_rate: 30, target_hours_per_week: 38, super_rate: 0, workers_comp_rate: 0, leave_loading_rate: 0, annual_fixed_oncosts: 0 },
  ],
  workEntries: [
    { staff_id: "s1", hours: 60 },
    { staff_id: "s1", hours: 40 }, // s1 worked 100
    // s2 worked 0
  ],
  leaveEntries: [
    { staff_id: "s1", leave_type: "sick", hours: 8 },
    { staff_id: "s1", leave_type: "annual", hours: 12 }, // s1 leave 20 (sick 8)
  ],
  equipment: [
    { id: "eq1", assigned_to: "s1", purchase_cost: 0, estimated_life_years: 0, insurance_annual: 0, maintenance_annual: 0, registration_annual: 0, other_annual_costs: 0, fuel_cost_per_hour: 10, target_hours_per_year: 100 } as StaffEffInput["equipment"][number], // $10/h
  ],
  nameByStaff: { s1: "Sam", s2: "Jo" },
};

describe("computeStaffEfficiency", () => {
  it("computes loaded rate (with vehicle), utilisation and true cost per worked hour", () => {
    const rows = computeStaffEfficiency(baseInput);
    const sam = rows.find((r) => r.name === "Sam")!;
    expect(sam.loadedHourlyRate).toBe(50); // vehicle folded in
    expect(sam.workedHours).toBe(100);
    expect(sam.leaveHours).toBe(20);
    expect(sam.sickHours).toBe(8);
    // utilisation = worked / (worked + leave) = 100 / 120
    expect(sam.utilizationPct).toBeCloseTo((100 / 120) * 100, 6);
    // true cost per worked hour = annualLoadedCost 104000 / 100
    expect(sam.trueCostPerWorkedHour).toBe(1040);
  });

  it("returns null utilisation + true-cost for staff with no worked/paid hours", () => {
    const jo = computeStaffEfficiency(baseInput).find((r) => r.name === "Jo")!;
    expect(jo.workedHours).toBe(0);
    expect(jo.utilizationPct).toBeNull();
    expect(jo.trueCostPerWorkedHour).toBeNull();
  });

  it("sorts by true cost per worked hour, highest first (nulls last)", () => {
    const rows = computeStaffEfficiency(baseInput);
    expect(rows[0].name).toBe("Sam"); // 1040 > null
  });
});
