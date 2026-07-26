import { summarizeCustomerInvoices } from "./customerSummary";

describe("summarizeCustomerInvoices", () => {
  it("totals all non-cancelled invoices, and outstanding = sent + overdue", () => {
    const r = summarizeCustomerInvoices([
      { total: 100, status: "paid" },
      { total: 200, status: "sent" },
      { total: 50, status: "overdue" },
      { total: 999, status: "cancelled" }, // excluded from both
      { total: 30, status: "draft" }, // counts to invoiced, not outstanding
    ]);
    expect(r.totalInvoiced).toBe(380); // 100 + 200 + 50 + 30
    expect(r.outstanding).toBe(250); // 200 + 50
  });

  it("is zero for no invoices and tolerates null totals", () => {
    expect(summarizeCustomerInvoices([])).toEqual({ totalInvoiced: 0, outstanding: 0 });
    expect(summarizeCustomerInvoices([{ total: null, status: "sent" }])).toEqual({ totalInvoiced: 0, outstanding: 0 });
  });
});
