import { describe, expect, it } from "vitest";
import { poInvoiceLines } from "@/lib/po-invoice";

describe("poInvoiceLines", () => {
  it("lists each priced line when they add up to the PO value", () => {
    const lines = poInvoiceLines({
      po_number: "4500123",
      total_value: 3000,
      lines: [
        { name: "Stormwater", allocated_amount: 2000, sort_order: 1 },
        { name: "Transport", allocated_amount: 0, sort_order: 2 },
        { name: "Sewer", allocated_amount: 1000, sort_order: 0 },
      ],
    });
    expect(lines.map((l) => [l.name, l.unit_price])).toEqual([["Sewer", "1000.00"], ["Stormwater", "2000.00"]]);
    expect(lines[0].description).toBe("PO 4500123");
  });

  it("falls back to one line for the PO value when the split doesn't add up", () => {
    expect(
      poInvoiceLines({ po_number: "77", total_value: 1500, lines: [{ name: "Sewer", allocated_amount: 1000 }] })
    ).toEqual([{ name: "PO 77", description: "", quantity: "1", unit_price: "1500.00" }]);
  });

  it("uses one line when the PO has no priced lines", () => {
    expect(poInvoiceLines({ po_number: "9", total_value: 812.5, lines: [] })[0].unit_price).toBe("812.50");
  });
});
