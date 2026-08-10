import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// THE DUPLICATE-BILL PATH — the same defect as tests/unit/xero-invoice-link.test.ts,
// on the sibling route that was never hardened.
//
// push-expense dedupes on one column:
//
//   route.ts:32  if (expense.xero_bill_id) return 400 "already pushed to Xero"
//
// and the write that sets it, after the bill has been created in Xero, discarded
// its result:
//
//   route.ts:69  await supabase.from("job_expenses")
//                  .update({ xero_bill_id: created?.invoiceID, ... })
//   route.ts:75  return NextResponse.json({ success: true, ... })
//
// So when that update failed, the route reported success, the next push saw a
// null xero_bill_id, sailed past the guard, and created the bill AGAIN.
//
// push-invoice documents this exact sequence as having already happened to a
// CUSTOMER invoice. Here the document is a creditor bill: an approved,
// authorised payable. A duplicate is money leaving the business twice.
//
// And a plain error is the wrong answer, for the reason push-invoice gives: by
// the time we know the link failed, the bill ALREADY EXISTS in Xero, so failing
// the request invites the very retry that duplicates it. The route must retry
// the link itself, and if it still cannot land, refuse in terms that stop a
// human pressing the button again.

const requireOfficeOrAdmin = vi.fn((..._a: unknown[]) => undefined as unknown);
const callerClient = vi.fn((..._a: unknown[]) => undefined as unknown);
const getRefreshedXero = vi.fn<
  (...a: unknown[]) => Promise<{ xero: unknown; tenantId: string; defaultExpenseAccountCode?: string }>
>(async () => ({ xero: {}, tenantId: "t" }));

vi.mock("@/lib/api/guards", () => ({
  requireAdmin: (...a: unknown[]) => requireOfficeOrAdmin(...a),
  requireOfficeOrAdmin: (...a: unknown[]) => requireOfficeOrAdmin(...a),
}));
vi.mock("@/lib/api/caller-client", () => ({ callerClient: (...a: unknown[]) => callerClient(...a) }));
vi.mock("@/lib/xero", () => ({
  getRefreshedXero: (...a: unknown[]) => getRefreshedXero(...a),
  describeXeroError: (e: unknown) => String(e),
}));

import { POST as pushExpense } from "@/app/api/xero/push-expense/route";

const req = () =>
  new NextRequest("https://app.test/api/xero/push-expense", {
    method: "POST",
    body: JSON.stringify({ expenseId: "exp-1" }),
  });

beforeEach(() => vi.clearAllMocks());

/** Supabase-shaped fake whose job_expenses UPDATE always fails. */
function clientWithFailingLinkWrite() {
  const expenseRow = {
    id: "exp-1",
    xero_bill_id: null,
    description: "Materials",
    amount: 250,
    expense_date: "2026-08-01",
    supplier: "Reece",
    jobs: { job_number: 833 },
  };

  const builder = (table: string): Record<string, unknown> => {
    const b: Record<string, unknown> = {};
    for (const m of ["select", "eq", "in", "order", "insert"]) b[m] = () => b;
    b.update = () =>
      table === "job_expenses"
        ? { eq: () => Promise.resolve({ error: { message: "could not serialize access due to concurrent update" } }) }
        : { eq: () => Promise.resolve({ error: null }) };
    b.maybeSingle = () => Promise.resolve({ data: expenseRow, error: null });
    b.single = b.maybeSingle;
    b.then = (resolve: (v: unknown) => unknown) => resolve({ data: [], error: null });
    return b;
  };
  return { from: (t: string) => builder(t) };
}

describe("push-expense — failing to record the Xero bill link", () => {
  beforeEach(() => {
    requireOfficeOrAdmin.mockResolvedValue({ ok: true, userId: "u1" });
    callerClient.mockReturnValue(clientWithFailingLinkWrite());
    getRefreshedXero.mockResolvedValue({
      xero: {
        accountingApi: {
          createInvoices: async () => ({
            body: { invoices: [{ invoiceID: "xero-bill-uuid-9", invoiceNumber: "BILL-4471" }] },
          }),
        },
      },
      tenantId: "t",
      defaultExpenseAccountCode: "400",
    });
  });

  it("does NOT report success when the link write failed", async () => {
    // The whole defect in one assertion: success here is what lets the next
    // push create a second authorised bill.
    const res = await pushExpense(req());
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it("names the Xero bill so it can be reconciled by hand", async () => {
    const res = await pushExpense(req());
    const body = await res.json();
    expect(JSON.stringify(body)).toContain("xero-bill-uuid-9");
  });

  it("warns explicitly that the bill EXISTS in Xero, so retrying duplicates it", async () => {
    const res = await pushExpense(req());
    const body = await res.json();
    expect(JSON.stringify(body).toLowerCase()).toMatch(/do not retry|already (created|exists)/);
  });

  it("flags that a human must reconcile, not that the push merely failed", async () => {
    // The caller needs to distinguish "nothing happened, try again" from
    // "something happened in Xero that we could not record".
    const res = await pushExpense(req());
    const body = await res.json();
    expect(body.requiresManualReconciliation).toBe(true);
  });
});
