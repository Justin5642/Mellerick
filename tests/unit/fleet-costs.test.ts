import { describe, it, expect } from "vitest";
import {
  costPerHourOf,
  usageCost,
  effectiveCostRate,
  financialYear,
  financialYearStartOf,
  financialYearsSince,
  summariseExpenses,
  trailingYear,
  MIN_ACTUAL_HOURS,
} from "@/lib/fleet-costs";
import { computeEquipmentCost } from "@/lib/equipment-cost";

const truck = {
  purchase_cost: 100_000,
  estimated_life_years: 10, // $10,000/yr depreciation
  insurance_annual: 3_000,
  maintenance_annual: 2_000,
  registration_annual: 1_000,
  other_annual_costs: 0,
  fuel_cost_per_hour: 20,
  target_hours_per_year: 1_000,
  purchase_date: "2020-01-01",
};

describe("financial years (1 July – 30 June)", () => {
  it("labels and bounds", () => {
    expect(financialYear(2026)).toEqual({ label: "FY 2026–27", start: "2026-07-01", end: "2027-06-30" });
    expect(financialYear(2099).label).toBe("FY 2099–00");
  });
  it("puts June in the year that started the previous July", () => {
    expect(financialYearStartOf("2026-06-30")).toBe(2025);
    expect(financialYearStartOf("2026-07-01")).toBe(2026);
  });
  it("lists every year back to the earliest expense, newest first", () => {
    expect(financialYearsSince(["2025-03-01", "2026-08-01"], "2026-11-14").map((y) => y.label)).toEqual(["FY 2026–27", "FY 2025–26", "FY 2024–25"]);
    expect(financialYearsSince([], "2026-11-14").map((y) => y.label)).toEqual(["FY 2026–27"]);
  });
});

describe("summariseExpenses", () => {
  const expenses = [
    { category: "service", amount: "450.00", gst_amount: "45.00", expense_date: "2026-07-03" },
    { category: "service", amount: 300, gst_amount: 30, expense_date: "2026-09-12" },
    { category: "tyres", amount: 1200.5, gst_amount: 120.05, expense_date: "2026-09-30" },
    { category: "fuel", amount: 99, gst_amount: 9.9, expense_date: "2026-06-30" }, // previous FY
  ];
  const s = summariseExpenses(expenses, financialYear(2026));

  it("totals the year by category, ex GST and GST separately", () => {
    expect(s.totalExGst).toBe(1950.5);
    expect(s.totalGst).toBe(195.05);
    expect(s.count).toBe(3);
    expect(s.byCategory.service).toEqual({ exGst: 750, gst: 75, count: 2 });
    expect(s.byCategory.fuel).toBeUndefined();
  });
  it("has all twelve months, zeros included", () => {
    expect(s.byMonth).toHaveLength(12);
    expect(s.byMonth[0]).toEqual({ month: "2026-07", exGst: 450 });
    expect(s.byMonth[2]).toEqual({ month: "2026-09", exGst: 1500.5 });
    expect(s.byMonth[11]).toEqual({ month: "2027-06", exGst: 0 });
  });
});

describe("effectiveCostRate", () => {
  const window = trailingYear("2026-11-14");

  it("trailing year is the 365 days ending today", () => {
    expect(window).toEqual({ start: "2025-11-15", end: "2026-11-14" });
  });

  it("actual = (depreciation + logged expenses) / hours worked, when there is enough data", () => {
    const r = effectiveCostRate({
      equipment: truck,
      expenses: [
        { category: "repair", amount: 9_000, expense_date: "2026-03-01" }, // the gearbox
        { category: "fuel", amount: 4_000, expense_date: "2026-05-01" },
        { category: "service", amount: 500, expense_date: "2025-01-01" }, // outside the window
      ],
      hoursWorked: 500,
      window,
    });
    expect(r.source).toBe("actual");
    expect(r.window.days).toBe(365);
    expect(r.actual.depreciation).toBe(10_000);
    expect(r.actual.expenses).toBe(13_000);
    expect(r.actual.fuelEstimate).toBe(0); // fuel was logged, so no estimate on top
    expect(r.costPerHour).toBe(46); // 23,000 / 500
    expect(r.estimateCostPerHour).toBe(computeEquipmentCost(truck).costPerHour); // 36
  });

  it("adds estimated fuel only when no fuel was logged", () => {
    const r = effectiveCostRate({ equipment: truck, expenses: [{ category: "service", amount: 1_000, expense_date: "2026-01-10" }], hoursWorked: 100, window });
    expect(r.actual.fuelEstimate).toBe(2_000); // 100h x $20
    expect(r.costPerHour).toBe(130); // (10,000 + 1,000 + 2,000) / 100
  });

  it("prorates depreciation for a machine bought part-way through the window", () => {
    const r = effectiveCostRate({
      equipment: { ...truck, purchase_date: "2026-08-17" }, // 90 days to 14 Nov
      expenses: [{ category: "fuel", amount: 1_000, expense_date: "2026-09-01" }],
      hoursWorked: 100,
      window,
    });
    expect(r.window.days).toBe(90);
    expect(r.actual.depreciation).toBeCloseTo(2465.75, 2);
  });

  it("keeps the estimate, and says why, until there is enough to divide by", () => {
    const few = effectiveCostRate({ equipment: truck, expenses: [{ category: "repair", amount: 9_000, expense_date: "2026-03-01" }], hoursWorked: MIN_ACTUAL_HOURS - 1, window });
    expect(few.source).toBe("estimate");
    expect(few.costPerHour).toBe(36);
    expect(few.reason).toMatch(/only 39\.0h worked/);

    const none = effectiveCostRate({ equipment: truck, expenses: [], hoursWorked: 500, window });
    expect(none.source).toBe("estimate");
    expect(none.reason).toMatch(/no expenses logged/);
  });

  it("costPerHourOf prefers the attached effective rate, else the estimate", () => {
    const r = effectiveCostRate({ equipment: truck, expenses: [{ category: "fuel", amount: 4_000, expense_date: "2026-05-01" }], hoursWorked: 200, window });
    expect(costPerHourOf({ ...truck, effective_rate: r })).toBe(70); // (10,000 + 4,000) / 200
    expect(costPerHourOf(truck)).toBe(36);
  });
});

describe("usageCost (hours, loads, tool days)", () => {
  const base = { ...truck, cost_per_load: 40, day_rate: 0 };
  it("hours at cost per hour plus loads at cost per load", () => {
    expect(usageCost({ hours: 2, loads: 3 }, base)).toBe(2 * 36 + 3 * 40);
  });
  it("an assigned vehicle's hours are in its driver's rate, but loads still count", () => {
    expect(usageCost({ hours: 2, loads: 3 }, { ...base, assigned_to: "tech-1" })).toBe(120);
  });
  it("a tool day costs the day rate (0100)", () => {
    const saw = { ...truck, purchase_cost: 0, insurance_annual: 0, maintenance_annual: 0, registration_annual: 0, fuel_cost_per_hour: 0, day_rate: "150" };
    expect(usageCost({ hours: 0, loads: 0, days: 1 }, saw)).toBe(150);
    expect(usageCost({ hours: 0, days: null }, saw)).toBe(0);
  });
});
