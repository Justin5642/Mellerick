import { describe, it, expect } from "vitest";
import { computeJobLedger, belowMinimumMargin, plantCosts, type LedgerInputs } from "@/lib/job-ledger";

// The job ledger: budget from the builder's PO split, against cost so far,
// per company cost centre (Stage 3).

const base = (over: Partial<LedgerInputs> = {}): LedgerInputs => ({
  costCentres: [
    { id: "bgd", name: "Below Ground Drainage" },
    { id: "transport", name: "Transport" },
  ],
  lines: [
    { id: "l-sewer", cost_centre_id: "bgd", allocated_amount: 9000, allocated_hours: 40 },
    { id: "l-storm", cost_centre_id: "bgd", allocated_amount: 2000, allocated_hours: 10 },
    { id: "l-cart", cost_centre_id: "transport", allocated_amount: 1500, allocated_hours: 0 },
  ],
  poTotal: 12500,
  timeEntries: [],
  ratesByStaff: new Map([["tech", 80]]),
  expenses: [],
  supplierOrders: [],
  plant: [],
  ...over,
});

describe("computeJobLedger", () => {
  it("adds budget lines up per company cost centre", () => {
    const l = computeJobLedger(base());
    expect(l.rows.map((r) => [r.name, r.budget, r.budgetHours])).toEqual([
      ["Below Ground Drainage", 11000, 50],
      ["Transport", 1500, 0],
    ]);
    expect(l.budget).toBe(12500);
    expect(l.unsplit).toBe(0);
  });

  it("costs labour, materials and supplier orders to the cost centre of their line", () => {
    const l = computeJobLedger(
      base({
        timeEntries: [{ staff_id: "tech", hours: 10, cost_center_id: "l-sewer", entry_type: "work" }],
        expenses: [{ amount: 400, cost_center_id: "l-storm" }],
        supplierOrders: [
          { amount: 600, cost_center_id: "l-cart", status: "received" },
          { amount: 999, cost_center_id: "l-cart", status: "cancelled" },
        ],
      })
    );
    const bgd = l.rows.find((r) => r.key === "bgd")!;
    const transport = l.rows.find((r) => r.key === "transport")!;
    expect(bgd).toMatchObject({ labour: 800, materials: 400, cost: 1200, hours: 10 });
    expect(transport).toMatchObject({ materials: 600, cost: 600 });
    expect(l.cost).toBe(1800);
    expect(l.margin).toBe(10700);
    expect(l.marginPct).toBe(85.6);
  });

  it("counts an unpriced supplier order as to-be-priced, not $0 spent", () => {
    const l = computeJobLedger(base({ supplierOrders: [{ amount: 0, cost_center_id: "l-cart", status: "ordered" }] }));
    expect(l.rows.find((r) => r.key === "transport")!.unpricedOrders).toBe(1);
    expect(l.unpricedOrders).toBe(1);
    expect(l.cost).toBe(0);
  });

  it("puts travel on its own row, and untagged costs and plant under Not tagged", () => {
    const l = computeJobLedger(
      base({
        timeEntries: [
          { staff_id: "tech", hours: 1, cost_center_id: null, entry_type: "travel" },
          { staff_id: "tech", hours: 2, cost_center_id: null, entry_type: "work" },
        ],
        plant: [{ cost: 250, cost_center_id: null }],
      })
    );
    expect(l.rows.slice(-2).map((r) => [r.key, r.cost])).toEqual([
      ["travel", 80],
      ["untagged", 410],
    ]);
  });

  it("reports hours by people with no rate as uncosted", () => {
    const l = computeJobLedger(base({ timeEntries: [{ staff_id: "nobody", hours: 3, cost_center_id: "l-sewer" }] }));
    expect(l.uncostedHours).toBe(3);
    expect(l.cost).toBe(0);
  });

  it("reports the part of the PO value not split", () => {
    expect(computeJobLedger(base({ poTotal: 13000 })).unsplit).toBe(500);
  });

  it("has no margin % without a budget", () => {
    expect(computeJobLedger(base({ lines: [], poTotal: 0 })).marginPct).toBeNull();
  });
});

describe("belowMinimumMargin", () => {
  it("flags a job whose spend already leaves less than the minimum", () => {
    expect(belowMinimumMargin({ budget: 10000, marginPct: 15 }, 20)).toBe(true);
    expect(belowMinimumMargin({ budget: 10000, marginPct: 25 }, 20)).toBe(false);
    expect(belowMinimumMargin({ budget: 0, marginPct: null }, 20)).toBe(false);
  });
});

describe("plantCosts", () => {
  const eq = {
    purchase_cost: 0, estimated_life_years: 1, insurance_annual: 0, maintenance_annual: 0,
    registration_annual: 0, other_annual_costs: 0, fuel_cost_per_hour: 50, target_hours_per_year: 1000,
  };

  it("skips equipment assigned to a person (already in their labour rate)", () => {
    const costs = plantCosts(
      [{ equipment_id: "digger", hours: 4 }, { equipment_id: "ute", hours: 4 }],
      [{ id: "digger", ...eq }, { id: "ute", assigned_to: "tech", ...eq }]
    );
    expect(costs).toEqual([{ cost: 200, cost_center_id: null }]);
  });

  it("adds loads at the cost per load — even on an assigned truck — on the usage's line", () => {
    const costs = plantCosts(
      [{ equipment_id: "truck", hours: 2, loads: 3, cost_center_id: "l-cart" }],
      [{ id: "truck", assigned_to: "driver", cost_per_load: 85, ...eq }]
    );
    expect(costs).toEqual([{ cost: 255, cost_center_id: "l-cart" }]);
  });
});

describe("computeJobLedger — plant on its cost centre", () => {
  it("puts tagged truck cost on the Transport row", () => {
    const l = computeJobLedger(base({ plant: [{ cost: 300, cost_center_id: "l-cart" }] }));
    expect(l.rows.find((r) => r.key === "transport")).toMatchObject({ plant: 300, cost: 300 });
  });
});
