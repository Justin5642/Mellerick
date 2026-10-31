jest.mock("./supabase", () => ({ supabase: { auth: { getSession: jest.fn() } } }));

import { costCentreLineForSupplier, matchSuppliers, supplierOrderProblem } from "./supplierOrders";

// The form refuses what the server would refuse, so the tech hears about it
// before tapping Send rather than after a round trip with no signal.
describe("supplierOrderProblem", () => {
  const ok = { costCenterId: "cc-1", supplierName: "Reece Epping", supplierEmail: "orders@reece.com.au", items: [{ description: "20mm elbow", quantity: 4 }] };

  it("accepts a complete order", () => {
    expect(supplierOrderProblem(ok)).toBeNull();
  });

  it("accepts an order with no email (counter or phone order)", () => {
    expect(supplierOrderProblem({ ...ok, supplierEmail: null })).toBeNull();
  });

  it("needs a cost centre", () => {
    expect(supplierOrderProblem({ ...ok, costCenterId: null })).toMatch(/cost centre/);
  });

  it("needs a supplier", () => {
    expect(supplierOrderProblem({ ...ok, supplierName: "  " })).toMatch(/supplier/);
  });

  it("rejects a malformed email", () => {
    expect(supplierOrderProblem({ ...ok, supplierEmail: "reece at gmail" })).toMatch(/email/);
  });

  it("ignores blank rows but needs at least one item", () => {
    expect(supplierOrderProblem({ ...ok, items: [{ description: " ", quantity: 1 }] })).toMatch(/at least one item/);
    expect(supplierOrderProblem({ ...ok, items: [...ok.items, { description: "", quantity: NaN }] })).toBeNull();
  });

  it("names the item with a bad quantity", () => {
    expect(supplierOrderProblem({ ...ok, items: [{ description: "Tee", quantity: 0 }] })).toMatch(/"Tee"/);
    expect(supplierOrderProblem({ ...ok, items: [{ description: "Tee", quantity: NaN }] })).toMatch(/"Tee"/);
  });
});

// The supplier list (copied from Xero) is searched as the tech types, often
// with gloves on: a few letters of any word should find it.
describe("matchSuppliers", () => {
  const list = [
    { id: "1", name: "Reece Epping", email: null },
    { id: "2", name: "Tradelink Thomastown", email: null },
    { id: "3", name: "Boral Quarries - Epping", email: null },
    { id: "4", name: "Plumbing Plus", email: null },
  ];

  it("shows the first few with nothing typed", () => {
    expect(matchSuppliers(list, "", 2).map((s) => s.id)).toEqual(["1", "2"]);
  });

  it("puts names starting with the search first, then any word", () => {
    expect(matchSuppliers(list, "epp").map((s) => s.id)).toEqual(["1", "3"]);
    expect(matchSuppliers(list, "quarr").map((s) => s.id)).toEqual(["3"]);
    expect(matchSuppliers(list, "tr").map((s) => s.id)).toEqual(["2"]);
  });

  it("is case-insensitive and ignores spaces around the search", () => {
    expect(matchSuppliers(list, "  REECE ").map((s) => s.id)).toEqual(["1"]);
  });
});

// Picking the quarry puts the PO on the job's Transport line by itself — but
// only when there is exactly one such line to pick.
describe("costCentreLineForSupplier", () => {
  const lines = [
    { id: "line-drain", costCentreId: "bgd" },
    { id: "line-transport", costCentreId: "transport" },
  ];

  it("finds the job's line for the supplier's usual cost centre", () => {
    expect(costCentreLineForSupplier({ defaultCostCentreId: "transport" }, lines)).toBe("line-transport");
  });

  it("leaves it to the tech with no usual cost centre, no match, or two matches", () => {
    expect(costCentreLineForSupplier({ defaultCostCentreId: null }, lines)).toBeNull();
    expect(costCentreLineForSupplier({ defaultCostCentreId: "civil" }, lines)).toBeNull();
    expect(costCentreLineForSupplier({ defaultCostCentreId: "bgd" }, [...lines, { id: "line-drain-2", costCentreId: "bgd" }])).toBeNull();
    expect(costCentreLineForSupplier({ defaultCostCentreId: "bgd" }, undefined)).toBeNull();
  });
});
