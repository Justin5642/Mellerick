import { describe, it, expect } from "vitest";
import { fleetHireOverview, hireRateText } from "@/lib/fleet-hire-overview";

// Fleet → Hire rates: Justin, 16 Nov 2026 — "The whole Fleet doesn't seem to be
// there." 0108 only priced machines whose names matched; the rest were
// invisible in Day Works. This overview lists every hireable machine and puts
// the unpriced ones first.

const equipment = [
  { id: "bobcat", name: "Kubota SVL75", category: "machinery", is_active: true },
  { id: "pc180", name: "Komatsu PC180", category: "machinery", is_active: true },
  { id: "tipper", name: "Quad axle tipper", category: "vehicle", is_active: true },
  { id: "float", name: "Quad axle float", category: "vehicle", is_active: true },
  { id: "pc18", name: "PC18", category: "machinery", is_active: true },
  { id: "saw", name: "Concrete saw", category: "tool", is_active: true },
  { id: "old", name: "Retired dozer", category: "machinery", is_active: false },
];
const options = [
  { equipment_id: "bobcat", hire_type: "wet" as const, hire_unit: "hour" as const, rate: 115.37, fuel_included: true, is_active: true },
  { equipment_id: "float", hire_type: "float" as const, hire_unit: "move" as const, rate: 0, float_base: 470, float_km_included: 30, float_per_km: 5, is_active: true },
  { equipment_id: "pc18", hire_type: "dry" as const, hire_unit: "day" as const, rate: "251.19", whole_days_only: true, fuel_included: false, is_active: false },
  { equipment_id: "saw", hire_type: "dry" as const, hire_unit: "day" as const, rate: 80, is_active: true },
];

describe("fleetHireOverview", () => {
  const { rows, missing } = fleetHireOverview(equipment, options);

  it("lists every active non-tool machine, unpriced ones first, then A–Z", () => {
    expect(rows.map((r) => r.name)).toEqual(["Komatsu PC180", "PC18", "Quad axle tipper", "Kubota SVL75", "Quad axle float"]);
    expect(missing).toBe(3);
  });

  it("a switched-off option is shown but doesn't count as a rate", () => {
    const pc18 = rows.find((r) => r.id === "pc18")!;
    expect(pc18.hasRate).toBe(false);
    expect(pc18.options).toEqual([{ label: "Dry hire, per day", rateText: "$251.19/day, full days, no fuel", active: false }]);
  });

  it("priced machines carry their label and rate", () => {
    expect(rows.find((r) => r.id === "bobcat")).toMatchObject({ hasRate: true, options: [{ label: "Wet hire, per hour", rateText: "$115.37/hr, fuel incl.", active: true }] });
    expect(rows.find((r) => r.id === "float")!.options[0].rateText).toBe("$470.00 base, 30 km incl., then $5.00/km");
  });

  it("an empty fleet has nothing missing", () => {
    expect(fleetHireOverview([], [])).toEqual({ rows: [], missing: 0 });
  });
});

describe("hireRateText", () => {
  it("names the unit", () => {
    expect(hireRateText({ equipment_id: "x", hire_type: "dry", hire_unit: "engine_hour", rate: 40, fuel_included: true })).toBe("$40.00/engine hr, fuel incl.");
    expect(hireRateText({ equipment_id: "x", hire_type: "cartage", hire_unit: "km", rate: 3.5 })).toBe("$3.50/km");
    expect(hireRateText({ equipment_id: "x", hire_type: "cartage", hire_unit: "contract", rate: 1200 })).toBe("$1,200.00 contract");
  });
});
