import { describe, it, expect } from "vitest";
import { customerPoLabel, normalizeCustomerPo } from "@/lib/customer-po";
import { xeroReference } from "@/lib/job-site";

describe("normalizeCustomerPo — what the 0083 check constraint accepts", () => {
  it("blank is NULL, never ''", () => {
    expect(normalizeCustomerPo("   ")).toBeNull();
    expect(normalizeCustomerPo(null)).toBeNull();
  });
  it("trims, collapses spaces and line breaks, caps at 60", () => {
    expect(normalizeCustomerPo("  4500\n123 ")).toBe("4500 123");
    expect(normalizeCustomerPo("9".repeat(80))).toHaveLength(60);
  });
});

describe("customerPoLabel", () => {
  it("adds PO once", () => {
    expect(customerPoLabel("4500123")).toBe("PO 4500123");
    expect(customerPoLabel("PO-4500123")).toBe("PO-4500123");
    expect(customerPoLabel("p.o. 77")).toBe("p.o. 77");
    expect(customerPoLabel("")).toBeNull();
  });
  it("does not mistake a word starting with po for a label", () => {
    expect(customerPoLabel("Pony 12")).toBe("PO Pony 12");
  });
});

describe("xeroReference with a PO", () => {
  const site = { jobNumber: 546, lines: ["Lot 2, 9 Pony Promenade", "Seymour VIC 3660"] };
  it("puts the PO first", () => {
    expect(xeroReference(site, "4500123")).toBe("PO 4500123 · Job #546 · Lot 2, 9 Pony Promenade, Seymour VIC 3660");
  });
  it("works with only a PO, and with nothing", () => {
    expect(xeroReference(null, "4500123")).toBe("PO 4500123");
    expect(xeroReference(null, null)).toBeUndefined();
  });
});
