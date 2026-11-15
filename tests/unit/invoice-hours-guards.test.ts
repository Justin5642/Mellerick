import { describe, expect, it, vi } from "vitest";
import { applyInvoiceHours, unpricedHoursOn } from "@/lib/invoice-hours";

// A chainable stand-in for the Supabase client: every query resolves to the
// rows given for its table. Enough for the guard checks, which return before
// any write.
function fakeDb(tables: Record<string, unknown>) {
  const rpc = vi.fn(async () => ({ data: { lines: 1, entries: 1, hours: 1, subtotal: 100, tax: 10, total: 110 }, error: null }));
  const from = (table: string) => {
    const rows = tables[table] ?? [];
    const result = { data: rows, error: null };
    const q: any = new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === "then") return (res: (v: unknown) => void) => res(result);
          if (prop === "maybeSingle" || prop === "single") return async () => ({ data: Array.isArray(rows) ? rows[0] ?? null : rows, error: null });
          return () => q;
        },
      }
    );
    return q;
  };
  return { db: { from, rpc } as any, rpc };
}

const invoice = (over: Record<string, unknown> = {}) => ({
  id: "inv1", job_id: "job1", status: "draft", xero_invoice_id: null, amount_paid: 0, ...over,
});
const choice = { mode: "all" as const, all: 120 };

describe("Apply hourly rate guards (audit, 15 Nov 2026)", () => {
  it("refuses a part-paid invoice", async () => {
    const { db, rpc } = fakeDb({ invoices: [invoice({ status: "sent", amount_paid: 50 })] });
    const r = await applyInvoiceHours(db, "inv1", choice);
    expect(r).toMatchObject({ ok: false, status: 400 });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("asks for confirmation when the invoice is already in Xero", async () => {
    const { db, rpc } = fakeDb({ invoices: [invoice({ xero_invoice_id: "x1", status: "sent" })] });
    const r = await applyInvoiceHours(db, "inv1", choice);
    expect(r).toMatchObject({ ok: false, status: 409, code: "confirm_outside" });
    expect(!r.ok && r.error).toMatch(/already in Xero/);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("asks for confirmation when the invoice was already emailed", async () => {
    const { db } = fakeDb({ invoices: [invoice({ status: "sent" })] });
    const r = await applyInvoiceHours(db, "inv1", choice);
    expect(r).toMatchObject({ ok: false, status: 409, code: "confirm_outside" });
    expect(!r.ok && r.error).toMatch(/emailed/);
  });

  it("goes ahead once confirmed (no hours here, so the rate step refuses — but not the guard)", async () => {
    const { db } = fakeDb({ invoices: [invoice({ xero_invoice_id: "x1", status: "sent" })] });
    const r = await applyInvoiceHours(db, "inv1", choice, true);
    expect(!r.ok && r.code).toBeFalsy();
  });

  it("counts no unpriced hours for an invoice without a job", async () => {
    const { db } = fakeDb({ invoices: [invoice({ job_id: null })] });
    expect(await unpricedHoursOn(db, "inv1")).toBe(0);
  });
});
