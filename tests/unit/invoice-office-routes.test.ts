import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import { canRecordPayment, parsePayment, paymentRecordedMessage, paymentStatusLabel, PAYMENT_IN_XERO } from "@/lib/invoice-payments";
import { claimBuilderPo, poForCustomerPo, pricedPos } from "@/lib/po-invoice";
import { claimColumns, claimDraftFromInvoice } from "@/lib/progress-claim";
import { DELETE_IN_XERO_WARNING, deleteInvoiceMessage, pushToXeroLabel } from "@/lib/invoice-actions";

// The office invoice actions the web did straight from the browser — record /
// remove a payment, delete an invoice — are now routes the web and the phone
// share (Justin, 19 Nov 2026). Office/admin, as the CALLER so
// RLS and 0081's triggers still decide; fixed-sentence errors.

const requireOfficeOrAdmin = vi.fn();
const requireAdmin = vi.fn();
vi.mock("@/lib/api/guards", () => ({
  requireOfficeOrAdmin: (...a: unknown[]) => requireOfficeOrAdmin(...a),
  requireAdmin: (...a: unknown[]) => requireAdmin(...a),
}));

// A tiny caller client: each table answers from `tables`; writes are recorded.
let tables: Record<string, { data: unknown; error: unknown; count?: number }>;
const writes: { table: string; op: string; payload?: unknown; filters: unknown[][] }[] = [];
function client() {
  return {
    from(table: string) {
      const rec = { table, op: "select", payload: undefined as unknown, filters: [] as unknown[][] };
      const answer = () => {
        const t = tables[`${table}:${rec.op}`] ?? tables[table] ?? { data: null, error: null };
        return t;
      };
      const q: any = {
        select: () => q,
        insert: (p: unknown) => ((rec.op = "insert"), (rec.payload = p), writes.push(rec), q),
        delete: () => ((rec.op = "delete"), writes.push(rec), q),
        eq: (...a: unknown[]) => (rec.filters.push(a), q),
        order: () => q,
        limit: () => q,
        maybeSingle: async () => answer(),
        then: (res: (v: unknown) => void) => res(answer()),
      };
      return q;
    },
  };
}
vi.mock("@/lib/api/caller-client", () => ({ callerClient: async () => client() }));

import { GET as getPayments, POST as postPayment } from "@/app/api/invoices/[id]/payments/route";
import { DELETE as deletePayment } from "@/app/api/invoices/[id]/payments/[paymentId]/route";
import { DELETE as deleteInvoice } from "@/app/api/invoices/[id]/route";

const req = (method: string, body?: unknown) =>
  new NextRequest("https://app.test/api/invoices/inv-1/payments", {
    method,
    headers: { authorization: "Bearer tok" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
const params = { params: Promise.resolve({ id: "inv-1" }) };
const forbidden = { ok: false, response: NextResponse.json({ error: "Insufficient permissions" }, { status: 403 }) };

beforeEach(() => {
  vi.clearAllMocks();
  writes.length = 0;
  tables = {};
  requireOfficeOrAdmin.mockResolvedValue({ ok: true, userId: "u1", role: "office" });
  requireAdmin.mockResolvedValue({ ok: true, userId: "u1", role: "admin" });
});

describe("parsePayment (shared by the web form, the phone and the route)", () => {
  it("accepts a payment and rounds it to the cent", () => {
    expect(parsePayment({ amount: "120.456", paid_on: "2026-11-19", method: "cash", reference: "  ref 1 " })).toEqual({
      ok: true,
      payment: { amount: 120.46, paid_on: "2026-11-19", method: "cash", reference: "ref 1" },
    });
  });
  it("defaults the method and drops a blank reference", () => {
    const r = parsePayment({ amount: 5, paid_on: "2026-11-19" });
    expect(r.ok && r.payment).toEqual({ amount: 5, paid_on: "2026-11-19", method: "bank_transfer", reference: null });
  });
  it("refuses no amount, zero, a bad date and an unknown method", () => {
    expect(parsePayment({ amount: "", paid_on: "2026-11-19" })).toEqual({ ok: false, error: "Enter the amount received." });
    expect(parsePayment({ amount: 0.001, paid_on: "2026-11-19" })).toEqual({ ok: false, error: "Enter the amount received." });
    expect(parsePayment({ amount: 10, paid_on: "19/11/2026" })).toEqual({ ok: false, error: "Enter the date the payment was received." });
    expect(parsePayment({ amount: 10, paid_on: "2026-11-19", method: "bitcoin" })).toEqual({ ok: false, error: "Choose how the payment was made." });
    expect(parsePayment(null).ok).toBe(false);
  });
  it("says what's left, and the card's headline", () => {
    expect(paymentRecordedMessage(100, 100)).toBe("Payment recorded — invoice paid");
    expect(paymentRecordedMessage(40, 100)).toBe("Payment recorded — $60.00 still owing");
    expect(paymentStatusLabel("draft", 100)).toBe("Not sent yet");
    expect(paymentStatusLabel("sent", 1234.5)).toBe("$1,234.50 owing");
    expect(paymentStatusLabel("paid", 0)).toBe("Paid in full");
    expect(canRecordPayment({ status: "overdue", xero_invoice_id: null, total: 10, amount_paid: 0 })).toBe(true);
  });
});

describe("builder POs and claims (moved out of the components, shared with the phone)", () => {
  it("picks a priced PO by the invoice's PO number", () => {
    const pos = pricedPos([
      { id: "a", po_number: "S-1", total_value: 100 },
      { id: "b", po_number: "X", total_value: 0 },
    ]);
    expect(pos).toHaveLength(1);
    expect(poForCustomerPo(pos, "S-1")?.id).toBe("a");
    expect(poForCustomerPo(pos, "")).toBeNull();
    expect(claimBuilderPo(pos, pos[0])).toBeNull(); // one PO: the whole job
  });
  it("round-trips a claim through the form", () => {
    const d = claimDraftFromInvoice({ is_progress_claim: true, claim_number: 2, claim_contract_value: "9200", claim_previous: null });
    expect(d).toEqual({ on: true, number: "2", contract: "9200", previous: "0" });
    expect(claimColumns(d)).toEqual({ ok: true, columns: { is_progress_claim: true, claim_number: 2, claim_contract_value: 9200, claim_previous: 0 } });
    expect(claimColumns({ ...d, contract: "" })).toEqual({ ok: false, error: "Enter the contract value (ex GST) for the progress claim" });
  });
});

describe("delete / Xero wording", () => {
  it("warns that an invoice in Xero stays in Xero", () => {
    expect(deleteInvoiceMessage("Sewer", false)).toContain("“Sewer”");
    expect(deleteInvoiceMessage("Sewer", false)).not.toContain("Xero");
    expect(deleteInvoiceMessage("Sewer", true)).toContain(DELETE_IN_XERO_WARNING);
    expect(pushToXeroLabel(true, false)).toBe("Update in Xero");
    expect(pushToXeroLabel(false, true)).toBe("Pushing to Xero...");
  });
});

describe("GET /api/invoices/[id]/payments", () => {
  it("is office/admin only", async () => {
    requireOfficeOrAdmin.mockResolvedValue(forbidden);
    const res = await getPayments(req("GET"), params);
    expect(res.status).toBe(403);
  });
  it("answers the balance, the payments and whether Xero is connected", async () => {
    tables = {
      invoices: { data: { id: "inv-1", status: "sent", total: 110, amount_paid: 10, xero_invoice_id: null }, error: null },
      invoice_payments: { data: [{ id: "p1", amount: "10.00", paid_on: "2026-11-01", method: "cash", reference: null }], error: null },
      xero_tokens: { data: { tenant_name: "Mellerick" }, error: null },
    };
    const body = await (await getPayments(req("GET"), params)).json();
    expect(body.invoice.balance).toBe(100);
    expect(body.payments).toEqual([{ id: "p1", amount: 10, paid_on: "2026-11-01", method: "cash", reference: null }]);
    expect(body.xeroConnected).toBe(true);
  });
  it("answers payments: null on a database without 0081", async () => {
    tables = {
      invoices: { data: { id: "inv-1", status: "sent", total: 110, amount_paid: 0, xero_invoice_id: null }, error: null },
      invoice_payments: { data: null, error: { code: "42P01", message: "relation does not exist" } },
      xero_tokens: { data: null, error: null },
    };
    const body = await (await getPayments(req("GET"), params)).json();
    expect(body.payments).toBeNull();
    expect(body.xeroConnected).toBe(false);
  });
});

describe("POST /api/invoices/[id]/payments", () => {
  it("is office/admin only, before anything is read", async () => {
    requireOfficeOrAdmin.mockResolvedValue(forbidden);
    const res = await postPayment(req("POST", { amount: 10, paid_on: "2026-11-19" }), params);
    expect(res.status).toBe(403);
    expect(writes).toHaveLength(0);
  });
  it("refuses a bad payment with the form's sentence", async () => {
    const res = await postPayment(req("POST", { amount: -1, paid_on: "2026-11-19" }), params);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Enter the amount received.");
  });
  it("refuses an invoice in Xero without inserting", async () => {
    tables = { invoices: { data: { id: "inv-1", total: 110, amount_paid: 0, xero_invoice_id: "x1" }, error: null } };
    const res = await postPayment(req("POST", { amount: 10, paid_on: "2026-11-19" }), params);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe(PAYMENT_IN_XERO);
    expect(writes).toHaveLength(0);
  });
  it("inserts the payment as the caller and answers the new balance", async () => {
    tables = {
      invoices: { data: { id: "inv-1", status: "sent", total: 110, amount_paid: 50, xero_invoice_id: null }, error: null },
      "invoice_payments:insert": { data: null, error: null },
    };
    const res = await postPayment(req("POST", { amount: 50, paid_on: "2026-11-19", method: "card" }), params);
    expect(res.status).toBe(200);
    expect(writes[0]).toMatchObject({ table: "invoice_payments", op: "insert", payload: { invoice_id: "inv-1", amount: 50, paid_on: "2026-11-19", method: "card", reference: null } });
    expect((await res.json()).balanceBefore).toBe(60);
  });
  it("hides a database error behind a fixed sentence", async () => {
    tables = {
      invoices: { data: { id: "inv-1", total: 110, amount_paid: 0, xero_invoice_id: null }, error: null },
      "invoice_payments:insert": { data: null, error: { code: "XX000", message: "secret internals" } },
    };
    const res = await postPayment(req("POST", { amount: 10, paid_on: "2026-11-19" }), params);
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe("The payment could not be saved. Please try again.");
  });
});

describe("DELETE /api/invoices/[id]/payments/[paymentId]", () => {
  const p = { params: Promise.resolve({ id: "inv-1", paymentId: "p1" }) };
  it("deletes only that invoice's payment", async () => {
    tables = { "invoice_payments:delete": { data: null, error: null, count: 1 } };
    const res = await deletePayment(req("DELETE"), p);
    expect(res.status).toBe(200);
    expect(writes[0].filters).toEqual([["id", "p1"], ["invoice_id", "inv-1"]]);
  });
  it("says so when nothing was removed", async () => {
    tables = { "invoice_payments:delete": { data: null, error: null, count: 0 } };
    const res = await deletePayment(req("DELETE"), p);
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("That payment could not be removed.");
  });
});

describe("DELETE /api/invoices/[id]", () => {
  it("is office/admin only", async () => {
    requireOfficeOrAdmin.mockResolvedValue(forbidden);
    const res = await deleteInvoice(req("DELETE"), params);
    expect(res.status).toBe(403);
    expect(writes).toHaveLength(0);
  });
  it("deletes and says whether it was in Xero", async () => {
    tables = {
      invoices: { data: { id: "inv-1", xero_invoice_id: "x1" }, error: null },
      "invoices:delete": { data: null, error: null, count: 1 },
    };
    const res = await deleteInvoice(req("DELETE"), params);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, inXero: true });
  });
  it("404s an invoice the caller can't see", async () => {
    tables = { invoices: { data: null, error: null } };
    const res = await deleteInvoice(req("DELETE"), params);
    expect(res.status).toBe(404);
  });
});
