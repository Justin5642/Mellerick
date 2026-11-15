import { approvalMessage, type ApproveResult } from "./approveJob";

jest.mock("./supabase", () => ({ supabase: { auth: { getSession: jest.fn() } } }));

// The phone's Approve now goes through the server (audit, 15 Nov 2026). What it
// tells the admin must never claim hours were billed when they were not.
const base: ApproveResult = { invoiceId: null, invoiceCreated: false, alreadyPushed: false, unpricedHours: 0, warnings: [] };

describe("approvalMessage", () => {
  it("a new invoice with hours says the hours still need a rate", () => {
    const m = approvalMessage({ ...base, invoiceId: "i", invoiceCreated: true, unpricedHours: 3.5 });
    expect(m).toContain("3.50h");
    expect(m).toContain("Apply an hourly rate");
  });

  it("an existing invoice does NOT claim the hours were added to it", () => {
    const m = approvalMessage({ ...base, invoiceId: "i", unpricedHours: 2 });
    expect(m).toContain("NOT on the existing invoice");
    expect(m).not.toMatch(/added to/i);
  });

  it("an invoice already in Xero says to push it again", () => {
    expect(approvalMessage({ ...base, invoiceId: "i", alreadyPushed: true, unpricedHours: 2 })).toContain("push it to Xero again");
  });

  it("names a progress claim as a progress claim", () => {
    expect(approvalMessage({ ...base, invoiceId: "c3", progressClaim: true, unpricedHours: 1 })).toContain("existing progress claim");
  });

  it("no invoice and nothing to bill goes to Ready-to-Invoice", () => {
    expect(approvalMessage(base)).toContain("Ready-to-Invoice");
  });

  it("carries the server's warnings through", () => {
    const m = approvalMessage({ ...base, invoiceId: "i", warnings: ["2 approved variations are not on the existing invoice."] });
    expect(m).toContain("2 approved variations");
  });
});
