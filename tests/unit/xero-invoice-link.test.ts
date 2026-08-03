import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// THE DUPLICATE-INVOICE PATH.
//
// After createInvoices() succeeds, the route writes xero_invoice_id back to our
// row. Its own comment says that write "is what stops a retry from creating a
// duplicate, so it must land even if the number adoption below fails" — and then
// discarded the result.
//
// So when the link write failed, the route still returned success. The next push
// of the same invoice saw no xero_invoice_id, took the CREATE branch again, and
// the customer received a second invoice in Xero for the same work.
//
// A retry cannot fix this, and that is what makes it different from the other
// silent failures: by the time we know the link write failed, the invoice ALREADY
// EXISTS in Xero. Failing the request and letting someone press the button again
// is precisely how the duplicate gets made. The route must (a) retry the link
// itself, and (b) if it still cannot link, say so in terms that stop a human
// retrying blind — naming the Xero invoice so it can be reconciled by hand.

const requireAdmin = vi.fn((..._a: unknown[]) => undefined as unknown);
const callerClient = vi.fn((..._a: unknown[]) => undefined as unknown);
// Annotated, not inferred: without this the return type is narrowed to the
// initial literal and mockResolvedValue rejects the extra fields the route
// actually reads. The web typecheck catches that, the test run does not.
const getRefreshedXero = vi.fn<
  (...a: unknown[]) => Promise<{
    xero: unknown;
    tenantId: string;
    defaultSalesAccountCode?: string;
  }>
>(async () => ({ xero: {}, tenantId: "t" }));

vi.mock("@/lib/api/guards", () => ({
  requireAdmin: (...a: unknown[]) => requireAdmin(...a),
  requireOfficeOrAdmin: (...a: unknown[]) => undefined,
}));
vi.mock("@/lib/api/caller-client", () => ({ callerClient: (...a: unknown[]) => callerClient(...a) }));
vi.mock("@/lib/xero", () => ({
  getRefreshedXero: (...a: unknown[]) => getRefreshedXero(...a),
  describeXeroError: (e: unknown) => String(e),
}));

import { POST as pushInvoice } from "@/app/api/xero/push-invoice/route";

const req = () => new NextRequest("https://app.test/api/xero/push-invoice", { method: "POST", body: JSON.stringify({ invoiceId: "inv-1" }) });

beforeEach(() => vi.clearAllMocks());

/**
 * A Supabase-shaped fake whose invoices UPDATE fails, so the link write cannot
 * land. Reads succeed so the route reaches the Xero call.
 */
function clientWithFailingLinkWrite() {
  const invoiceRow = {
    id: "inv-1",
    xero_invoice_id: null,
    invoice_number: 1,
    due_date: "2026-08-10T00:00:00.000Z",
    created_at: "2026-08-01T00:00:00.000Z",
    jobs: { job_number: 833 },
    customers: { name: "Acme", email: "a@example.com" },
    invoice_items: [{ name: "Labour", quantity: 1, unit_price: 100, total: 100 }],
  };

  const builder = (table: string): Record<string, unknown> => {
    const b: Record<string, unknown> = {};
    for (const m of ["select", "eq", "in", "order", "insert"]) b[m] = () => b;
    b.update = () =>
      table === "invoices"
        ? { eq: () => Promise.resolve({ error: { message: "could not serialize access due to concurrent update" } }) }
        : { eq: () => Promise.resolve({ error: null }) };
    b.maybeSingle = () => Promise.resolve({ data: invoiceRow, error: null });
    b.single = b.maybeSingle;
    b.then = (resolve: (v: unknown) => unknown) => resolve({ data: [], error: null });
    return b;
  };
  return { from: (t: string) => builder(t) };
}

describe("push-invoice — failing to record the Xero link", () => {
  beforeEach(() => {
    requireAdmin.mockResolvedValue({ ok: true, userId: "u1" });
    callerClient.mockReturnValue(clientWithFailingLinkWrite());
    getRefreshedXero.mockResolvedValue({
      xero: {
        accountingApi: {
          createInvoices: async () => ({
            body: { invoices: [{ invoiceID: "xero-uuid-1", invoiceNumber: "INV-12144" }] },
          }),
          updateInvoice: async () => ({ body: { invoices: [] } }),
        },
      },
      tenantId: "t",
      defaultSalesAccountCode: "200",
    });
  });

  it("does NOT report success when the link write failed", async () => {
    const res = await pushInvoice(req());
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it("names the Xero invoice so it can be reconciled by hand", async () => {
    // Without the identifier the operator cannot find what was created, and the
    // only obvious action left is to press the button again.
    const res = await pushInvoice(req());
    const body = await res.json();
    expect(JSON.stringify(body)).toContain("INV-12144");
  });

  it("warns explicitly that the invoice EXISTS in Xero, so retrying duplicates it", async () => {
    const res = await pushInvoice(req());
    const body = await res.json();
    expect(JSON.stringify(body).toLowerCase()).toMatch(/do not retry|already (created|exists)/);
  });
});
