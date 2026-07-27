import { summarizeCustomerInvoices } from "./customerSummary";

describe("summarizeCustomerInvoices", () => {
  it("total invoiced = ALL invoices (incl cancelled); outstanding = not-paid-not-cancelled (matches web)", () => {
    const r = summarizeCustomerInvoices([
      { total: 100, status: "paid" }, // in total, not outstanding
      { total: 200, status: "sent" }, // both
      { total: 50, status: "overdue" }, // both
      { total: 999, status: "cancelled" }, // total only (excluded from outstanding)
      { total: 30, status: "draft" }, // both (draft is owed, matching web)
    ]);
    expect(r.totalInvoiced).toBe(1379); // 100 + 200 + 50 + 999 + 30
    expect(r.outstanding).toBe(280); // 200 + 50 + 30
  });

  it("is zero for no invoices and tolerates null totals", () => {
    expect(summarizeCustomerInvoices([])).toEqual({ totalInvoiced: 0, outstanding: 0 });
    expect(summarizeCustomerInvoices([{ total: null, status: "sent" }])).toEqual({ totalInvoiced: 0, outstanding: 0 });
  });
});
