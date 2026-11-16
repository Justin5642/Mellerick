import { describe, it, expect } from "vitest";
import { attentionName, billingName } from "@/lib/customer-billing";

describe("customer billing name", () => {
  it("bills the company, with the person as Attn", () => {
    const c = { name: "Simon Buchanan", company: "Landart Landscapes" };
    expect(billingName(c)).toBe("Landart Landscapes");
    expect(attentionName(c)).toBe("Simon Buchanan");
  });
  it("falls back to the name, with no Attn, when there is no company", () => {
    expect(billingName({ name: "Jo Smith", company: "  " })).toBe("Jo Smith");
    expect(attentionName({ name: "Jo Smith", company: null })).toBeNull();
  });
  it("no Attn when the company and name are the same (Simpro imports)", () => {
    expect(attentionName({ name: "Acme Homes", company: "acme homes" })).toBeNull();
  });
});
