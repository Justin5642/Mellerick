jest.mock("./supabase", () => ({ supabase: { auth: { getSession: jest.fn() } } }));

import { supplierOrderProblem } from "./supplierOrders";

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
