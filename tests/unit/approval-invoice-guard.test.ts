import { describe, it, expect } from "vitest";
import { resolveExistingInvoice } from "../../lib/approval-invoice-guard";

// The approvals screen guarded against double-invoicing a job by looking for an
// existing invoice — and discarded the lookup's error. A failed check was
// therefore indistinguishable from "no invoice exists", and the approval created
// one anyway.
//
// The asymmetry is the whole point. Refusing to approve is an inconvenience
// someone retries in ten seconds. Creating a second invoice bills a real
// customer twice, reaches Xero, and has to be credited.

describe("resolveExistingInvoice", () => {
  it("proceeds with no invoice when the job genuinely has none", () => {
    expect(resolveExistingInvoice({ data: [], error: null })).toEqual({
      proceed: true,
      invoiceId: null,
      alreadyPushed: false,
      progressClaim: false,
    });
  });

  it("proceeds and reuses the existing invoice", () => {
    expect(resolveExistingInvoice({ data: [{ id: "inv-1" }], error: null })).toMatchObject({
      proceed: true,
      invoiceId: "inv-1",
      alreadyPushed: false,
    });
  });

  it("reports an invoice already pushed to Xero", () => {
    const v = resolveExistingInvoice({ data: [{ id: "inv-1", xero_invoice_id: "XERO-9" }], error: null });
    expect(v).toMatchObject({ proceed: true, invoiceId: "inv-1", alreadyPushed: true });
  });

  // THE BUG.
  it("STOPS on a failed lookup instead of treating it as 'no invoice'", () => {
    const v = resolveExistingInvoice({ data: null, error: { message: "network error" } });
    expect(v.proceed).toBe(false);
  });

  it("says WHY it stopped, so the operator can act rather than retry blindly", () => {
    const v = resolveExistingInvoice({ data: null, error: { message: "permission denied" } });
    expect(v.proceed).toBe(false);
    if (!v.proceed) {
      expect(v.reason).toContain("permission denied");
      expect(v.reason).toContain("duplicate");
    }
  });

  // The case the guard exists for.
  it("STOPS when the job ALREADY has two ordinary invoices", () => {
    const v = resolveExistingInvoice({ data: [{ id: "a" }, { id: "b" }], error: null });
    expect(v.proceed).toBe(false);
    if (!v.proceed) expect(v.reason).toContain("more than one invoice");
  });

  it("distinguishes 'already duplicated' from an ordinary failure in its message", () => {
    const dup = resolveExistingInvoice({ data: [{ id: "a" }, { id: "b" }], error: null });
    const net = resolveExistingInvoice({ data: null, error: { message: "timeout" } });
    expect(dup.proceed).toBe(false);
    expect(net.proceed).toBe(false);
    if (!dup.proceed && !net.proceed) expect(dup.reason).not.toBe(net.reason);
  });

  // Audit, 15 Nov 2026: claim-billed jobs were refused forever once requeued.
  it("PROCEEDS for a job billed by several progress claims, using the latest claim", () => {
    const v = resolveExistingInvoice({
      data: [
        { id: "c1", is_progress_claim: true, claim_number: 1, xero_invoice_id: "X1" },
        { id: "c3", is_progress_claim: true, claim_number: 3, xero_invoice_id: null },
        { id: "c2", is_progress_claim: true, claim_number: 2, xero_invoice_id: "X2" },
      ],
      error: null,
    });
    expect(v).toEqual({ proceed: true, invoiceId: "c3", alreadyPushed: false, progressClaim: true });
  });

  it("prefers the one ordinary invoice over claims", () => {
    const v = resolveExistingInvoice({
      data: [
        { id: "c1", is_progress_claim: true, claim_number: 1 },
        { id: "final", is_progress_claim: false },
      ],
      error: null,
    });
    expect(v).toMatchObject({ proceed: true, invoiceId: "final", progressClaim: false });
  });

  it("still STOPS on two ordinary invoices even when claims exist too", () => {
    const v = resolveExistingInvoice({
      data: [{ id: "c1", is_progress_claim: true, claim_number: 1 }, { id: "a" }, { id: "b" }],
      error: null,
    });
    expect(v.proceed).toBe(false);
  });
});
