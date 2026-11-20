import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { billingAddressLines, isMissingBillingAddressColumn, normaliseBillingAddress } from "@/lib/customer-address";
import { loadBillingAddress } from "@/lib/customer-address-load";

const body = (f: string) => {
  const src = readFileSync(f, "utf8");
  return src.slice(src.indexOf("\n\n") + 2);
};

describe("customer billing address", () => {
  it("the phone's copy is byte-identical below its header", () => {
    expect(body("mobile/lib/customerAddress.ts")).toBe(body("lib/customer-address.ts"));
    expect(body("lib/customer-address.ts").length).toBeGreaterThan(500);
  });

  it("tidies what was typed: trims lines, drops blank ends, collapses blank runs", () => {
    expect(normaliseBillingAddress("  PO Box 12 \r\n\r\n\r\n Nutfield VIC 3099  \n\n")).toEqual({ ok: true, value: "PO Box 12\n\nNutfield VIC 3099" });
    expect(normaliseBillingAddress("   \n  ")).toEqual({ ok: true, value: null });
    expect(normaliseBillingAddress(null)).toEqual({ ok: true, value: null });
  });

  it("refuses more than 500 characters (0114's check)", () => {
    expect(normaliseBillingAddress("x".repeat(500))).toEqual({ ok: true, value: "x".repeat(500) });
    expect(normaliseBillingAddress("x".repeat(501)).ok).toBe(false);
  });

  it("prints one line per non-blank line", () => {
    expect(billingAddressLines("Level 2\n\n 10 Smith St \nCraigieburn VIC 3064")).toEqual(["Level 2", "10 Smith St", "Craigieburn VIC 3064"]);
    expect(billingAddressLines(null)).toEqual([]);
  });

  it("recognises only the missing billing_address column", () => {
    expect(isMissingBillingAddressColumn({ code: "42703", message: "column customers.billing_address does not exist" })).toBe(true);
    expect(isMissingBillingAddressColumn({ code: "PGRST204", message: "Could not find the 'billing_address' column" })).toBe(true);
    expect(isMissingBillingAddressColumn({ code: "42703", message: "column customers.abn does not exist" })).toBe(false);
  });
});

describe("loadBillingAddress", () => {
  const client = (answer: unknown) => {
    const chain: Record<string, unknown> = {};
    chain.select = () => chain;
    chain.eq = () => chain;
    chain.maybeSingle = async () => answer;
    return { from: vi.fn(() => chain) } as never;
  };

  it("reads the address as the caller", async () => {
    expect(await loadBillingAddress(client({ data: { billing_address: "PO Box 1\nNutfield" }, error: null }), "c1")).toBe("PO Box 1\nNutfield");
  });

  it("answers null — never throws — before 0114, on any error, blank or without a customer", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await loadBillingAddress(client({ data: null, error: { code: "42703", message: "column customers.billing_address does not exist" } }), "c1")).toBeNull();
    expect(err).not.toHaveBeenCalled();
    expect(await loadBillingAddress(client({ data: null, error: { code: "500", message: "boom" } }), "c1")).toBeNull();
    expect(await loadBillingAddress(client({ data: { billing_address: "  " }, error: null }), "c1")).toBeNull();
    expect(await loadBillingAddress(client({ data: null, error: null }), null)).toBeNull();
    const throwing = { from: () => { throw new Error("x"); } } as never;
    expect(await loadBillingAddress(throwing, "c1")).toBeNull();
    err.mockRestore();
  });
});
