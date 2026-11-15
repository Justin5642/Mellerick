import { describe, it, expect } from "vitest";
import { ourPoNumbers, supplierKey } from "../../lib/supplier-invoice-refs";
import { clean, isoDate } from "../../lib/supplier-invoice-read";

// Supplier invoices (0103): what the reader returns is tidied before it is
// stored, and our PO numbers are found however the supplier printed them.

describe("ourPoNumbers", () => {
  it("finds our PO however it was printed", () => {
    expect(ourPoNumbers(["PO-1008"])).toEqual(["PO-1008"]);
    expect(ourPoNumbers(["PO 1008"])).toEqual(["PO-1008"]);
    expect(ourPoNumbers(["po1008"])).toEqual(["PO-1008"]);
    expect(ourPoNumbers(["P.O. #1008"])).toEqual(["PO-1008"]);
    expect(ourPoNumbers(["1008"])).toEqual(["PO-1008"]);
    expect(ourPoNumbers(["#1008"])).toEqual(["PO-1008"]);
  });

  it("does not invent a PO from a name, a builder PO or a short number", () => {
    expect(ourPoNumbers(["JOHN SMITH"])).toEqual([]);
    expect(ourPoNumbers(["4321-2"])).toEqual([]);
    expect(ourPoNumbers(["42"])).toEqual([]);
    expect(ourPoNumbers(["Job 2542 Garden World"])).toEqual([]);
  });

  it("lists each PO once", () => {
    expect(ourPoNumbers(["PO-1008", "po 1008", "PO-1010"])).toEqual(["PO-1008", "PO-1010"]);
  });
});

describe("supplierKey", () => {
  it("treats the same supplier written differently as one", () => {
    expect(supplierKey("Reece Pty Ltd")).toBe(supplierKey("REECE"));
    expect(supplierKey("Tradelink Australia")).toBe(supplierKey("tradelink"));
  });
  it("keeps different suppliers apart", () => {
    expect(supplierKey("Reece")).not.toBe(supplierKey("Tradelink"));
  });
});

describe("clean", () => {
  const raw = {
    doc_kind: "invoice" as const,
    supplier_name: "  Reece  ",
    supplier_abn: null,
    invoice_number: " INV-1 ",
    invoice_date: "2026-02-30",
    amount_ex_gst: 100.005,
    gst_amount: 10,
    total: 110.005,
    order_refs: ["PO-1008", " PO-1008 ", ""],
    job_refs: [],
    site_text: "   ",
  };

  it("trims text, rounds money to the cent and drops blank or repeated refs", () => {
    const c = clean(raw);
    expect(c.supplier_name).toBe("Reece");
    expect(c.invoice_number).toBe("INV-1");
    expect(c.amount_ex_gst).toBe(100.01);
    expect(c.order_refs).toEqual(["PO-1008"]);
    expect(c.site_text).toBeNull();
  });

  it("refuses a date that does not exist", () => {
    expect(clean(raw).invoice_date).toBeNull();
    expect(isoDate("2026-11-14")).toBe("2026-11-14");
    expect(isoDate("14/11/2026")).toBeNull();
  });
});
