import { describe, it, expect, vi, beforeEach } from "vitest";

// pollXeroInvoicePayments is how "what's owed" stays true for invoices in
// Xero: paid ones flip to paid, late ones to overdue, and (since 19 Oct 2026)
// part-payments update amount_paid so "Owed to us" shows the real balance
// instead of the full total until the last cent lands.

const getInvoices = vi.fn();

vi.mock("xero-node", () => {
  class XeroClient {
    accountingApi = { getInvoices: (...a: unknown[]) => getInvoices(...a) };
    setTokenSet() {}
    async initialize() {}
    async refreshToken() {
      return {};
    }
  }
  return { XeroClient, Invoice: { StatusEnum: { PAID: "PAID" } } };
});

const TOKEN = {
  id: "tok",
  access_token: "a",
  refresh_token: "r",
  token_expiry: new Date(Date.now() + 3_600_000).toISOString(),
  tenant_id: "tenant",
};

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: () => {
      const chain: Record<string, unknown> = {};
      for (const m of ["select", "eq", "update"]) chain[m] = () => chain;
      chain.single = async () => ({ data: TOKEN, error: null });
      chain.then = (r: (v: { error: null }) => unknown) => r({ error: null });
      return chain;
    },
  }),
}));

import { pollXeroInvoicePayments } from "@/lib/xero";

type Upd = { id: string; payload: Record<string, unknown> };

function invoicesClient(rows: unknown[], updates: Upd[]) {
  return {
    from: () => {
      let payload: Record<string, unknown> | null = null;
      const chain: Record<string, unknown> = {};
      chain.select = () => chain;
      chain.in = () => chain;
      chain.not = () => chain;
      chain.update = (p: Record<string, unknown>) => {
        payload = p;
        return chain;
      };
      chain.eq = (_c: string, id: string) => {
        if (payload) updates.push({ id, payload });
        return chain;
      };
      chain.then = (r: (v: unknown) => unknown) => r(payload ? { error: null } : { data: rows, error: null });
      return chain;
    },
  };
}

beforeEach(() => getInvoices.mockReset());

describe("pollXeroInvoicePayments", () => {
  it("marks fully paid, records part-payments, and flags late invoices", async () => {
    const rows = [
      { id: "paid", xero_invoice_id: "x1", status: "sent", due_date: "2099-01-01", total: 100, amount_paid: 0 },
      { id: "part", xero_invoice_id: "x2", status: "sent", due_date: "2099-01-01", total: 500, amount_paid: 0 },
      { id: "late", xero_invoice_id: "x3", status: "sent", due_date: "2000-01-01", total: 300, amount_paid: 0 },
    ];
    getInvoices.mockResolvedValue({
      body: {
        invoices: [
          { invoiceID: "x1", status: "PAID", amountPaid: 100, amountDue: 0, fullyPaidOnDate: "2026-10-18" },
          { invoiceID: "x2", status: "AUTHORISED", amountPaid: 200, amountDue: 300 },
          { invoiceID: "x3", status: "AUTHORISED", amountPaid: 0, amountDue: 300 },
        ],
      },
    });
    const updates: Upd[] = [];
    const res = await pollXeroInvoicePayments(invoicesClient(rows, updates));

    expect(res.failed).toEqual([]);
    expect(updates.find((u) => u.id === "paid")!.payload).toMatchObject({ status: "paid", amount_paid: 100 });
    expect(updates.find((u) => u.id === "part")!.payload).toEqual({ amount_paid: 200 });
    expect(updates.find((u) => u.id === "late")!.payload).toEqual({ status: "overdue" });
  });

  it("writes nothing for an unpaid, not-yet-due invoice that has not changed", async () => {
    getInvoices.mockResolvedValue({ body: { invoices: [{ invoiceID: "x1", status: "AUTHORISED", amountPaid: 0, amountDue: 100 }] } });
    const updates: Upd[] = [];
    await pollXeroInvoicePayments(
      invoicesClient([{ id: "i", xero_invoice_id: "x1", status: "sent", due_date: "2099-01-01", total: 100, amount_paid: 0 }], updates)
    );
    expect(updates).toEqual([]);
  });
});
