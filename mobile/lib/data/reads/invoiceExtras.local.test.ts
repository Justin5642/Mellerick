// The office invoice extras' local path (Owed to us, the job's builder POs):
// a fake LocalReads fed SQLite-shaped rows; the output must be the shape the
// remote path returns. The previous-claim read is Supabase only.
jest.mock("../../supabase", () => {
  const chain: Record<string, unknown> = {};
  for (const m of ["from", "select", "eq", "neq", "in", "is", "order", "range", "limit", "single", "maybeSingle"]) {
    chain[m] = jest.fn(() => chain);
  }
  chain.then = (onFulfilled: (v: { data: unknown[] }) => unknown, onRejected?: (e: unknown) => unknown) =>
    Promise.resolve({ data: [] }).then(onFulfilled, onRejected);
  return { supabase: chain };
});

import { supabase } from "../../supabase";
import { resetSourceForTests, setLocalReads, type LocalReads } from "./source";
import {
  getInvoiceJobPos,
  getPreviousClaim,
  listOwedInvoices,
  SQL_INVOICE_JOB_CUSTOMER_PO,
  SQL_INVOICE_JOB_PO_LINES,
  SQL_INVOICE_JOB_POS,
  SQL_OWED_INVOICES,
} from "./invoiceExtras";
import { summarizeOwed } from "../../invoicePayments";

function fakeReads(data: Map<string, unknown>, role: "office" | "technician" = "office"): LocalReads {
  return {
    hasSynced: () => true,
    role: () => role,
    getAll: jest.fn(async (sql: string) => (data.get(sql) as unknown[]) ?? []) as unknown as LocalReads["getAll"],
    getOptional: jest.fn(async (sql: string) => data.get(sql) ?? null) as unknown as LocalReads["getOptional"],
  };
}

afterEach(() => {
  resetSourceForTests();
  jest.clearAllMocks();
});

describe("listOwedInvoices (local)", () => {
  it("maps sent/overdue invoices to the web's OwedInvoice shape, and they sum like the web", async () => {
    setLocalReads(
      fakeReads(
        new Map([
          [
            SQL_OWED_INVOICES,
            [
              { id: "i1", invoice_number: 7, title: "Sewer", total: "1100", amount_paid: 100, due_date: "2026-10-01", status: "overdue", customer_name: "Acme" },
              { id: "i2", invoice_number: 8, title: "Storm", total: 550, amount_paid: null, due_date: "2026-12-01", status: "sent", customer_name: null },
            ],
          ],
        ])
      )
    );
    const rows = await listOwedInvoices();
    expect(rows).toEqual([
      { id: "i1", invoice_number: 7, title: "Sewer", total: 1100, amount_paid: 100, due_date: "2026-10-01", status: "overdue", customers: { name: "Acme" } },
      { id: "i2", invoice_number: 8, title: "Storm", total: 550, amount_paid: null, due_date: "2026-12-01", status: "sent", customers: null },
    ]);
    const s = summarizeOwed(rows, "2026-11-19");
    expect(s.outstanding).toBe(1550);
    expect(s.overdue).toBe(1000);
    expect(s.count).toBe(2);
    expect(supabase.from).not.toHaveBeenCalled();
  });

  it("is office-only: a technician's read never touches the mirror", async () => {
    const fake = fakeReads(new Map(), "technician");
    setLocalReads(fake);
    await listOwedInvoices().catch(() => undefined);
    expect(fake.getAll).not.toHaveBeenCalled();
  });
});

describe("getInvoiceJobPos (local)", () => {
  it("returns the job's PO number and each PO with its own lines", async () => {
    const fake = fakeReads(
      new Map<string, unknown>([
        [SQL_INVOICE_JOB_CUSTOMER_PO, { customer_po: "B-77" }],
        [
          SQL_INVOICE_JOB_POS,
          [
            { id: "po1", po_number: "S-1", total_value: "5000" },
            { id: "po2", po_number: "SW-2", total_value: null },
          ],
        ],
        [
          SQL_INVOICE_JOB_PO_LINES,
          [
            { po_id: "po1", name: "Drainage", allocated_amount: 4000, sort_order: 0 },
            { po_id: "po1", name: "Transport", allocated_amount: "1000", sort_order: 1 },
          ],
        ],
      ])
    );
    setLocalReads(fake);
    await expect(getInvoiceJobPos("job-1")).resolves.toEqual({
      customerPo: "B-77",
      pos: [
        {
          id: "po1",
          po_number: "S-1",
          total_value: 5000,
          lines: [
            { name: "Drainage", allocated_amount: 4000, sort_order: 0 },
            { name: "Transport", allocated_amount: 1000, sort_order: 1 },
          ],
        },
        { id: "po2", po_number: "SW-2", total_value: 0, lines: [] },
      ],
    });
    expect(fake.getAll).toHaveBeenCalledWith(SQL_INVOICE_JOB_POS, ["job-1"]);
    expect(fake.getAll).toHaveBeenCalledWith(SQL_INVOICE_JOB_PO_LINES, ["job-1"]);
  });
});

describe("getPreviousClaim", () => {
  it("asks Supabase, never the mirror, scoped to the PO and leaving out the invoice being edited", async () => {
    const fake = fakeReads(new Map());
    setLocalReads(fake);
    await expect(getPreviousClaim("job-1", { excludeInvoiceId: "inv-1", poNumber: "S-1" })).resolves.toBeNull();
    expect(fake.getAll).not.toHaveBeenCalled();
    expect(supabase.from).toHaveBeenCalledWith("invoices");
    const chain = supabase as unknown as Record<string, jest.Mock>;
    expect(chain.neq).toHaveBeenCalledWith("id", "inv-1");
    expect(chain.eq).toHaveBeenCalledWith("customer_po", "S-1");
    expect(chain.eq).toHaveBeenCalledWith("is_progress_claim", true);
  });
});
