import { describe, expect, it } from "vitest";
import { poInvoiceLines, poInvoiceState } from "@/lib/po-invoice";

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

describe("poInvoiceState", () => {
  const po = { id: "p1", po_number: "4500123", total_value: 12000 };
  const inv = (over: Record<string, unknown>) => ({ id: "i", invoice_number: 101, subtotal: 12000, status: "sent", customer_po: "4500123", ...over });

  it("is not invoiced when no invoice names the PO", () => {
    expect(poInvoiceState(po, [inv({ customer_po: "999" }), inv({ customer_po: null })]).status).toBe("none");
  });

  it("is fully invoiced once its value is on invoices (Emma's sewer PO)", () => {
    const s = poInvoiceState(po, [inv({})]);
    expect(s.status).toBe("full");
    expect(s.remaining).toBe(0);
    expect(s.invoices.map((i) => i.invoice_number)).toEqual([101]);
  });

  it("adds progress claims up and says what's left", () => {
    const s = poInvoiceState(po, [inv({ id: "a", subtotal: 4000 }), inv({ id: "b", subtotal: "3000.50" })]);
    expect(s).toMatchObject({ status: "part", invoiced: 7000.5, remaining: 4999.5 });
    expect(poInvoiceState(po, [inv({ subtotal: 4000 }), inv({ subtotal: 8000 })]).status).toBe("full");
  });

  it("ignores cancelled invoices and matches the number loosely", () => {
    expect(poInvoiceState(po, [inv({ status: "cancelled" })]).status).toBe("none");
    expect(poInvoiceState(po, [inv({ customer_po: " 4500123 " })]).status).toBe("full");
    expect(poInvoiceState({ ...po, po_number: "LUX-827-S" }, [inv({ customer_po: "lux-827-s" })]).status).toBe("full");
  });
});
