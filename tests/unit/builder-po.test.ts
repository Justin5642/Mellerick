import { describe, it, expect } from "vitest";
import { planBuilderPo, planBuilderPoLines, remainingToSplit, type BuilderPoLineInput } from "@/lib/builder-po";

// A builder's PO value split across company cost centres (Stage 2). The value
// is what the builder agreed to pay, so it is kept as entered; lines that
// don't add up to it are reported, never used to change it.

const CENTRES = [
  { id: "bgd", name: "Below Ground Drainage" },
  { id: "transport", name: "Transport" },
];
const line = (over: Partial<BuilderPoLineInput> = {}): BuilderPoLineInput => ({ costCentreId: "bgd", stage: "", amount: "", hours: "", ...over });

describe("planBuilderPo", () => {
  it("splits a drainage PO between drainage and transport", () => {
    const r = planBuilderPo(
      { value: "$12,500", lines: [line({ amount: "11000", hours: "40", stage: "Sewer" }), line({ costCentreId: "transport", amount: "1500" })] },
      CENTRES
    );
    expect(r.ok && r.po).toEqual({
      value: 12500,
      totalHours: 40,
      unallocated: 0,
      lines: [
        { cost_centre_id: "bgd", name: "Sewer", allocated_amount: 11000, allocated_hours: 40, sort_order: 0 },
        { cost_centre_id: "transport", name: "Transport", allocated_amount: 1500, allocated_hours: 0, sort_order: 1 },
      ],
    });
  });

  it("keeps the value as entered and reports what isn't split", () => {
    const r = planBuilderPo({ value: "10000", lines: [line({ amount: "6000" })] }, CENTRES);
    expect(r.ok && r.po.value).toBe(10000);
    expect(r.ok && r.po.unallocated).toBe(4000);
  });

  it("allows saving with no split yet (a quote total to split later)", () => {
    const r = planBuilderPo({ value: "8000", lines: [line({ costCentreId: "" })] }, CENTRES);
    expect(r.ok && r.po.lines).toEqual([]);
  });

  it("needs a value", () => {
    expect(planBuilderPo({ value: "", lines: [] }, CENTRES)).toEqual({ ok: false, error: "Enter the PO value (ex GST)." });
    expect(planBuilderPo({ value: "abc", lines: [] }, CENTRES).ok).toBe(false);
  });

  it("needs a cost centre on any line with something typed", () => {
    const r = planBuilderPo({ value: "1000", lines: [line({ costCentreId: "", amount: "500" })] }, CENTRES);
    expect(r).toEqual({ ok: false, error: "Pick a cost centre for every line." });
  });

  it("refuses a bad amount or negative hours", () => {
    expect(planBuilderPoLines([line({ amount: "lots" })], CENTRES).ok).toBe(false);
    expect(planBuilderPoLines([line({ hours: "-2" })], CENTRES).ok).toBe(false);
  });
});

describe("remainingToSplit", () => {
  it("starts a new line at what's left", () => {
    expect(remainingToSplit("12500", [line({ amount: "11000" })])).toBe("1500.00");
  });

  it("is blank once fully split or with no value", () => {
    expect(remainingToSplit("1000", [line({ amount: "1000" })])).toBe("");
    expect(remainingToSplit("", [])).toBe("");
  });
});
