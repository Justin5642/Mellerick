import { describe, it, expect } from "vitest";
import { computeJobLedger } from "@/lib/job-ledger";
import { creditRefusal, creditTotals, loadOrderCredits, withCredits } from "@/lib/vendor-order-credits";

// Supplier credit notes against a PO (0125): the rules and the ledger netting.

describe("creditRefusal", () => {
  const order = { po_number: "PO-1008", status: "received", invoice_number: "INV-1", amount: 200 };
  it("lets a credit up to what's left of the invoice", () => {
    expect(creditRefusal(order, [{ amount_ex_gst: 150, credit_number: "CR-1" }], { amount_ex_gst: 50, credit_number: "CR-2" })).toBeNull();
  });
  it("refuses one cent more", () => {
    expect(creditRefusal(order, [{ amount_ex_gst: 150, credit_number: "CR-1" }], { amount_ex_gst: 50.01, credit_number: "CR-2" })).toMatch(/\$50\.00/);
  });
  it("refuses a cancelled order, an order with no invoice, and the same credit number twice", () => {
    expect(creditRefusal({ ...order, status: "cancelled" }, [], { amount_ex_gst: 1, credit_number: null })).toMatch(/cancelled/);
    expect(creditRefusal({ ...order, invoice_number: null }, [], { amount_ex_gst: 1, credit_number: null })).toMatch(/no invoice/);
    expect(creditRefusal(order, [{ amount_ex_gst: 1, credit_number: "cr-1 " }], { amount_ex_gst: 1, credit_number: "CR-1" })).toMatch(/already/);
  });
});

describe("the ledger nets credits off their order", () => {
  const base = {
    costCentres: [{ id: "cc1", name: "Drainage" }],
    lines: [{ id: "l1", cost_centre_id: "cc1", allocated_amount: 1000, allocated_hours: 0 }],
    poTotal: 1000,
    timeEntries: [],
    ratesByStaff: new Map<string, number>(),
    expenses: [],
    plant: [],
  };
  it("materials = order amount − its credits", () => {
    const orders = [
      { id: "o1", amount: 400, cost_center_id: "l1", status: "received" },
      { id: "o2", amount: 100, cost_center_id: "l1", status: "received" },
    ];
    const totals = creditTotals([
      { vendor_order_id: "o1", amount_ex_gst: 30 },
      { vendor_order_id: "o1", amount_ex_gst: 20 },
    ]);
    expect(totals.get("o1")).toBe(50);
    const ledger = computeJobLedger({ ...base, supplierOrders: withCredits(orders, totals) });
    expect(ledger.rows.find((r) => r.key === "cc1")?.materials).toBe(450);
    expect(ledger.cost).toBe(450);
  });
  it("never below $0, and an unpriced order stays 'to be priced'", () => {
    const ledger = computeJobLedger({
      ...base,
      supplierOrders: [
        { amount: 10, cost_center_id: "l1", status: "received", credits: 50 },
        { amount: 0, cost_center_id: "l1", status: "ordered", credits: 5 },
      ],
    });
    expect(ledger.rows.find((r) => r.key === "cc1")).toMatchObject({ materials: 0, unpricedOrders: 1 });
  });
});

describe("loadOrderCredits", () => {
  const db = (error: unknown, data: unknown[] = []) =>
    ({ from: () => ({ select: () => ({ in: () => ({ order: async () => ({ data, error }) }) }) }) }) as never;
  it("before 0125: not ready, no credits, no error", async () => {
    expect(await loadOrderCredits(db({ code: "42P01" }), ["o1"])).toEqual({ ready: false, credits: [], error: null });
    expect(await loadOrderCredits(db({ code: "PGRST205" }), ["o1"])).toEqual({ ready: false, credits: [], error: null });
  });
  it("another failure is an error with no credits", async () => {
    const r = await loadOrderCredits(db({ code: "XX000" }), ["o1"]);
    expect(r.credits).toEqual([]);
    expect(r.error).toBeTruthy();
  });
});
