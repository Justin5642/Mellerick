import { computeEquipmentUtilization, type EquipUtilInput } from "./equipmentUtilization";

// EQ2 from costing.test: dep 6000 + 2000+3000+1000 fixed = 12000 annualFixed;
// fuel 8/h * 1000 target = 8000 fuel; annualTotal 20000; costPerHour 20.
const eq = (id: string, name: string): EquipUtilInput["equipment"][number] => ({
  id,
  name,
  purchase_cost: 60000,
  estimated_life_years: 10,
  insurance_annual: 2000,
  maintenance_annual: 3000,
  registration_annual: 1000,
  other_annual_costs: 0,
  fuel_cost_per_hour: 8,
  target_hours_per_year: 1000,
});

describe("computeEquipmentUtilization", () => {
  it("computes utilisation and true cost per hour used (fixed/hoursUsed + fuel)", () => {
    const [row] = computeEquipmentUtilization({ equipment: [eq("e1", "Truck")], usage: [{ equipment_id: "e1", hours: 300 }, { equipment_id: "e1", hours: 200 }] });
    expect(row.hoursUsed).toBe(500);
    expect(row.budgetedCostPerHour).toBe(20); // annualTotal 20000 / 1000
    expect(row.annualTotalCost).toBe(20000);
    expect(row.utilizationPct).toBe(50); // 500 / 1000
    expect(row.trueCostPerHourUsed).toBe(32); // 12000/500 + 8 = 24 + 8
  });

  it("returns null utilisation + true-cost for unused equipment", () => {
    const [row] = computeEquipmentUtilization({ equipment: [eq("e2", "Idle")], usage: [] });
    expect(row.hoursUsed).toBe(0);
    expect(row.utilizationPct).toBe(0); // target > 0, hoursUsed 0 => 0%
    expect(row.trueCostPerHourUsed).toBeNull();
  });

  it("sorts by true cost per hour used, highest first", () => {
    const rows = computeEquipmentUtilization({
      equipment: [eq("e1", "Busy"), eq("e2", "Barely")],
      usage: [{ equipment_id: "e1", hours: 900 }, { equipment_id: "e2", hours: 10 }],
    });
    // Barely-used has a far higher true cost/hour (12000/10 + 8) -> sorts first.
    expect(rows[0].name).toBe("Barely");
  });
});
