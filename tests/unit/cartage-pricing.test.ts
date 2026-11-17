import { describe, it, expect } from "vitest";
import {
  defaultBilling,
  effectiveMargin,
  invoiceLineFromLoad,
  invoiceLinesFromLoads,
  loadRoute,
  priceLoad,
  truckRates,
  type CartageLoadQuantities,
  type InvoiceableLoad,
  type TruckRates,
} from "@/lib/cartage-pricing";
import { hireOptionLabel, isValidHireUnit, machineCharge } from "@/lib/hire-pricing";

// Truck loads pricing (0111) — Justin's rules, 17 Nov 2026.

const TIPPER = "truck-1";
const rates: TruckRates = { perKm: 3, perTonne: 28, perM3: 40 };

const spoil = (over: Partial<CartageLoadQuantities> = {}): CartageLoadQuantities => ({
  id: "l1",
  equipment_id: TIPPER,
  direction: "spoil_out",
  billing: "extra",
  quantity: 12,
  unit: "tonne",
  km: 35,
  ...over,
});
const rock = (over: Partial<CartageLoadQuantities> = {}): CartageLoadQuantities => ({
  id: "l2",
  equipment_id: TIPPER,
  direction: "material_in",
  billing: "extra",
  quantity: 20,
  unit: "tonne",
  km: 40,
  ...over,
});

describe("defaults", () => {
  it("spoil out is extra; quarry product is included unless the job says otherwise", () => {
    expect(defaultBilling("spoil_out", null)).toBe("extra");
    expect(defaultBilling("spoil_out", true)).toBe("extra");
    expect(defaultBilling("material_in", null)).toBe("included");
    expect(defaultBilling("material_in", true)).toBe("included");
    expect(defaultBilling("material_in", false)).toBe("extra");
  });

  it("margin: the load's override, else the company's, else 15%", () => {
    expect(effectiveMargin({ margin_pct: 25 }, 15)).toBe(25);
    expect(effectiveMargin({ margin_pct: 0 }, 15)).toBe(0);
    expect(effectiveMargin({ margin_pct: null }, 18)).toBe(18);
    expect(effectiveMargin(null, null)).toBe(15);
  });
});

describe("truck rates", () => {
  it("reads the active cartage km / tonne / m³ options for that truck only", () => {
    const options = [
      { equipment_id: TIPPER, hire_type: "cartage" as const, hire_unit: "tonne" as const, rate: "28.00" },
      { equipment_id: TIPPER, hire_type: "cartage" as const, hire_unit: "km" as const, rate: 3, is_active: true },
      { equipment_id: TIPPER, hire_type: "cartage" as const, hire_unit: "m3" as const, rate: 40, is_active: false },
      { equipment_id: "other", hire_type: "cartage" as const, hire_unit: "m3" as const, rate: 99 },
      { equipment_id: TIPPER, hire_type: "wet" as const, hire_unit: "hour" as const, rate: 150 },
    ];
    expect(truckRates(options, TIPPER)).toEqual({ perKm: 3, perTonne: 28, perM3: null });
  });

  it("tonne and m³ are cartage units only", () => {
    expect(isValidHireUnit("cartage", "tonne")).toBe(true);
    expect(isValidHireUnit("cartage", "m3")).toBe(true);
    expect(isValidHireUnit("wet", "tonne")).toBe(false);
    expect(hireOptionLabel({ hire_type: "cartage", hire_unit: "m3" })).toBe("Cartage, per m³ (truck loads)");
    // Never a Day Works entry's unit: nothing to charge if one ever appeared.
    expect(machineCharge({ id: "x", equipment_id: TIPPER, hire_type: "cartage", hire_unit: "tonne", work_date: "2026-11-17" }, { equipment_id: TIPPER, hire_type: "cartage", hire_unit: "tonne", rate: 28 }).amount).toBe(0);
  });
});

describe("pricing an extra spoil load", () => {
  it("= quantity × per-tonne rate + tip fee × (1 + margin) + km × per km", () => {
    const p = priceLoad(spoil(), rates, { docket_cost_ex_gst: 180, margin_pct: null }, 15);
    expect(p.kind === "extra" && p.ok).toBe(true);
    if (p.kind !== "extra" || !p.ok) return;
    // 12 × 28 = 336; 180 × 1.15 = 207; 35 × 3 = 105
    expect(p.lines.map((l) => l.amount)).toEqual([336, 207, 105]);
    expect(p.total).toBe(648);
    expect(p.marginPct).toBe(15);
    expect(p.cost).toBe(180);
  });

  it("per m³ uses the m³ rate, and the load's margin override", () => {
    const p = priceLoad(spoil({ unit: "m3", quantity: 8.5, km: 0 }), rates, { docket_cost_ex_gst: "100.00", margin_pct: "20" }, 15);
    // 8.5 × 40 = 340; 100 × 1.2 = 120; no km line
    expect(p).toMatchObject({ kind: "extra", ok: true, total: 460, marginPct: 20 });
    if (p.kind === "extra" && p.ok) expect(p.lines).toHaveLength(2);
  });

  it("a tip fee of $0 entered by the office is priced (entered is not missing)", () => {
    expect(priceLoad(spoil({ km: 0 }), rates, { docket_cost_ex_gst: 0, margin_pct: null }, 15)).toMatchObject({ ok: true, total: 336 });
  });

  it("refuses rather than pricing at $0", () => {
    const problem = (l: CartageLoadQuantities, r: TruckRates = rates, cost: { docket_cost_ex_gst: number | null; margin_pct: null } | null = { docket_cost_ex_gst: 180, margin_pct: null }) => {
      const p = priceLoad(l, r, cost, 15);
      return p.kind === "extra" && !p.ok ? p.problem : null;
    };
    expect(problem(spoil(), rates, null)).toMatch(/tip fee/);
    expect(problem(spoil(), rates, { docket_cost_ex_gst: null, margin_pct: null })).toMatch(/tip fee/);
    expect(problem(spoil(), { ...rates, perTonne: null })).toMatch(/per tonne/);
    expect(problem(spoil({ unit: "m3" }), { ...rates, perM3: null })).toMatch(/per m³/);
    expect(problem(spoil(), { ...rates, perKm: null })).toMatch(/per km/);
    expect(problem(spoil({ unit: "load" }))).toMatch(/per tonne or m³/);
    expect(problem(spoil({ quantity: 0 }))).toMatch(/how much/);
    expect(problem(spoil({ quantity: null }))).toMatch(/how much/);
    expect(problem(spoil({ km: null }))).toMatch(/km/);
  });

  it("no km travelled needs no per-km rate", () => {
    expect(priceLoad(spoil({ km: 0 }), { ...rates, perKm: null }, { docket_cost_ex_gst: 100, margin_pct: 0 }, 15)).toMatchObject({ ok: true, total: 436 });
  });
});

describe("pricing an extra material load", () => {
  it("= product cost × (1 + margin) + km × per km (+ cartage when the truck has that unit's rate)", () => {
    const withCartage = priceLoad(rock(), rates, { docket_cost_ex_gst: 600, margin_pct: null }, 15);
    // 20 × 28 = 560; 600 × 1.15 = 690; 40 × 3 = 120
    expect(withCartage).toMatchObject({ kind: "extra", ok: true, total: 1370 });
    const noTonneRate = priceLoad(rock(), { ...rates, perTonne: null }, { docket_cost_ex_gst: 600, margin_pct: null }, 15);
    expect(noTonneRate).toMatchObject({ kind: "extra", ok: true, total: 810 });
    const byTheLoad = priceLoad(rock({ unit: "load", quantity: 1 }), rates, { docket_cost_ex_gst: 600, margin_pct: 10 }, 15);
    expect(byTheLoad).toMatchObject({ kind: "extra", ok: true, total: 780 });
  });

  it("needs the product cost", () => {
    expect(priceLoad(rock(), rates, null, 15)).toMatchObject({ kind: "extra", ok: false, problem: expect.stringMatching(/quarry product cost/) });
  });

  it("an included load is a cost only, never a price", () => {
    expect(priceLoad(rock({ billing: "included" }), rates, { docket_cost_ex_gst: 600, margin_pct: null }, 15)).toEqual({ kind: "included", cost: 600 });
    expect(priceLoad(rock({ billing: "included" }), rates, null, 15)).toEqual({ kind: "included", cost: null });
  });
});

describe("invoice lines", () => {
  const signed = (over: Partial<InvoiceableLoad> = {}): InvoiceableLoad => ({
    ...spoil(),
    load_date: "2026-11-17",
    place: "Wollert tip",
    docket_number: "1234",
    signer_name: "Sam Builder",
    status: "signed",
    invoice_id: null,
    ...over,
  });

  it("names the spoil, route and docket; one line at the load's whole price; no margin shown", () => {
    const line = invoiceLineFromLoad(signed(), rates, { docket_cost_ex_gst: 180, margin_pct: null }, 15, "Isuzu tipper", "12 Smith St, Craigieburn");
    expect(line).toEqual({
      name: "Spoil removal 12 t — 12 Smith St, Craigieburn → Wollert tip, docket 1234",
      description: "17 Nov 2026 · Isuzu tipper · 35 km · signed by Sam Builder",
      quantity: 1,
      unit_price: 648,
    });
    expect(`${line.name} ${line.description}`).not.toMatch(/%|margin|180/);
  });

  it("quarry product runs quarry → site, named by its material", () => {
    expect(loadRoute({ direction: "material_in", place: "Northern Quarries", from_text: null, to_text: null }, "Lot 4")).toBe("Northern Quarries → Lot 4");
    expect(loadRoute({ direction: "spoil_out", place: "Tip", from_text: "Stockpile", to_text: "  " }, "Lot 4")).toBe("Stockpile → Tip");
    const line = invoiceLineFromLoad(
      signed({ ...rock(), material: "Crushed rock 20mm", place: "Northern Quarries", docket_number: null }),
      rates,
      { docket_cost_ex_gst: 600, margin_pct: null },
      15,
      "Tipper",
      "Lot 4"
    );
    expect(line.name).toBe("Crushed rock 20mm 20 t — Northern Quarries → Lot 4");
  });

  it("refuses an unsigned, already invoiced, included or unpriceable load", () => {
    const cost = { docket_cost_ex_gst: 180, margin_pct: null };
    expect(() => invoiceLineFromLoad(signed({ status: "draft" }), rates, cost, 15, "T", null)).toThrow(/signed/);
    expect(() => invoiceLineFromLoad(signed({ invoice_id: "inv" }), rates, cost, 15, "T", null)).toThrow(/signed/);
    expect(() => invoiceLineFromLoad(signed({ billing: "included" }), rates, cost, 15, "T", null)).toThrow(/included/);
    expect(() => invoiceLineFromLoad(signed(), rates, null, 15, "T", null)).toThrow(/tip fee/);
  });

  it("several loads, oldest first", () => {
    const lines = invoiceLinesFromLoads(
      [signed({ id: "b", load_date: "2026-11-18" }), signed({ id: "a", load_date: "2026-11-16" })],
      () => rates,
      new Map([
        ["a", { docket_cost_ex_gst: 100, margin_pct: 0 }],
        ["b", { docket_cost_ex_gst: 100, margin_pct: 0 }],
      ]),
      15,
      new Map([[TIPPER, "Tipper"]]),
      "Site"
    );
    expect(lines.map((l) => l.description.slice(0, 11))).toEqual(["16 Nov 2026", "18 Nov 2026"]);
  });
});
