import { describe, it, expect } from "vitest";
import { variationLineDescription, variationQtyText } from "@/lib/variation-qty";

describe("custom variations have no quantity", () => {
  it("shows nothing for a custom variation saved as 1", () => {
    expect(variationQtyText({ variation_type_id: null, quantity: 1, unit: "unit" })).toBe("");
    expect(variationLineDescription({ variation_type_id: null, quantity: 1, unit: "unit", rate: 580 })).toBe("");
  });
  it("keeps an older custom variation that had a real quantity", () => {
    expect(variationQtyText({ variation_type_id: null, quantity: 3, unit: "unit" })).toBe("3 unit");
  });
  it("keeps standard types' quantity and rate", () => {
    expect(variationLineDescription({ variation_type_id: "t", quantity: 20, unit: "m³", rate: 28 })).toBe("20 m³ @ $28.00");
  });
});
