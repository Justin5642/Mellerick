import { FinanceRepository, computeTotals } from "./finance";
import type { Outbox } from "../outbox/outbox";
import type { IdGen } from "../ids";
import type { Operation, WriteOperation } from "../outbox/types";
import type { TimeSource } from "../time";

function seqIds(): IdGen {
  let n = 0;
  return { newId: () => `id-${++n}` };
}
const fixedTime = (ms = 1_000): TimeSource => ({ nowMs: () => ms, nowIso: () => "2026-07-22T00:00:00.000Z" });

function captureOutbox(): { outbox: Outbox; ops: WriteOperation[] } {
  const ops: WriteOperation[] = [];
  const outbox = { enqueue: jest.fn(async (op: Operation) => void ops.push(op as WriteOperation)) } as unknown as Outbox;
  return { outbox, ops };
}
const byTable = (ops: WriteOperation[], table: string) => ops.filter((o) => o.table === table);

describe("computeTotals", () => {
  it("computes subtotal, 10% GST and total", () => {
    expect(computeTotals([{ name: "a", quantity: 2, unitPrice: 50 }, { name: "b", quantity: 1, unitPrice: 20 }])).toEqual({
      subtotal: 120,
      gst: 12,
      total: 132,
    });
  });
  it("is zero for no items", () => {
    expect(computeTotals([])).toEqual({ subtotal: 0, gst: 0, total: 0 });
  });
});

describe("FinanceRepository.createInvoice", () => {
  it("inserts a draft invoice with computed totals and item rows that depend on it, without per-line totals", async () => {
    const { outbox, ops } = captureOutbox();
    const repo = new FinanceRepository(outbox, seqIds(), fixedTime());
    const id = await repo.createInvoice({
      customerId: "cust-1",
      jobId: "job-1",
      title: "Backflow retest",
      items: [
        { name: "Labour", quantity: 2, unitPrice: 90 },
        { name: "Parts", quantity: 1, unitPrice: 30 },
      ],
    });

    const [inv] = byTable(ops, "invoices");
    expect(id).toBe("id-1");
    expect(inv.op).toBe("insert");
    expect(inv.rowId).toBe("id-1");
    expect(inv.payload).toMatchObject({ customer_id: "cust-1", job_id: "job-1", title: "Backflow retest", status: "draft", subtotal: 210, tax_amount: 21, total: 231 });

    const items = byTable(ops, "invoice_items");
    expect(items).toHaveLength(2);
    for (const it of items) {
      expect(it.op).toBe("insert");
      expect(it.dependsOn).toBe(inv.id); // items never insert before the invoice row
      expect(it.payload.invoice_id).toBe("id-1");
      expect(it.payload).not.toHaveProperty("total"); // DB GENERATED column
    }
    expect(items[0].payload).toMatchObject({ name: "Labour", quantity: 2, unit_price: 90 });
  });
});

describe("FinanceRepository.editInvoice", () => {
  it("updates the invoice then deletes old items and inserts new ones, all gated on the update", async () => {
    const { outbox, ops } = captureOutbox();
    const repo = new FinanceRepository(outbox, seqIds(), fixedTime());
    await repo.editInvoice({
      invoiceId: "inv-9",
      title: "Updated",
      existingItemIds: ["old-1", "old-2"],
      items: [{ name: "New line", quantity: 3, unitPrice: 10 }],
    });

    const [upd] = byTable(ops, "invoices");
    expect(upd.op).toBe("update");
    expect(upd.rowId).toBe("inv-9");
    expect(upd.payload).toMatchObject({ title: "Updated", subtotal: 30, tax_amount: 3, total: 33 });

    const itemOps = byTable(ops, "invoice_items");
    const deletes = itemOps.filter((o) => o.op === "delete");
    const inserts = itemOps.filter((o) => o.op === "insert");
    expect(deletes.map((d) => d.rowId).sort()).toEqual(["old-1", "old-2"]);
    expect(inserts).toHaveLength(1);
    for (const o of itemOps) expect(o.dependsOn).toBe(upd.id); // never run before the invoice update
  });
});

describe("FinanceRepository quotes + pricing", () => {
  it("createQuote inserts a draft quote + items (quote_id set, no total)", async () => {
    const { outbox, ops } = captureOutbox();
    const repo = new FinanceRepository(outbox, seqIds(), fixedTime());
    await repo.createQuote({ customerId: "c1", title: "Q", validUntilIso: "2026-08-01", items: [{ name: "x", quantity: 1, unitPrice: 100 }] });
    expect(byTable(ops, "quotes")[0].payload).toMatchObject({ status: "draft", valid_until: "2026-08-01", subtotal: 100, tax_amount: 10, total: 110 });
    const item = byTable(ops, "quote_items")[0];
    expect(item.payload.quote_id).toBe("id-1");
    expect(item.payload).not.toHaveProperty("total");
  });

  it("setQuoteStatus updates only the status", async () => {
    const { outbox, ops } = captureOutbox();
    const repo = new FinanceRepository(outbox, seqIds(), fixedTime());
    await repo.setQuoteStatus("q1", "accepted");
    expect(ops[0]).toMatchObject({ table: "quotes", op: "update", rowId: "q1", payload: { status: "accepted" } });
  });

  it("pricing create/update/deactivate enqueue the right ops", async () => {
    const { outbox, ops } = captureOutbox();
    const repo = new FinanceRepository(outbox, seqIds(), fixedTime());
    const id = await repo.createPricingItem({ name: "Callout", category: "labour", pricingType: "flat_rate", unitPrice: 120 });
    expect(id).toBe("id-1");
    expect(ops[0]).toMatchObject({ table: "pricing_items", op: "insert", payload: { name: "Callout", pricing_type: "flat_rate", unit_price: 120, unit: "each", is_active: true } });

    const box2 = captureOutbox();
    await new FinanceRepository(box2.outbox, seqIds(), fixedTime()).deactivatePricingItem("p1");
    expect(box2.ops[0]).toMatchObject({ table: "pricing_items", op: "update", rowId: "p1", payload: { is_active: false } });
  });
});
