import { JobBillingRepository } from "./jobBilling";
import type { Outbox } from "../outbox/outbox";
import type { IdGen } from "../ids";
import type { Operation, WriteOperation } from "../outbox/types";
import type { TimeSource } from "../time";

function seqIds(): IdGen {
  let n = 0;
  return { newId: () => `id-${++n}` };
}
const fixedTime = (ms = 1_000): TimeSource => ({ nowMs: () => ms, nowIso: () => "2026-07-26T00:00:00.000Z" });
function captureOutbox(): { outbox: Outbox; ops: WriteOperation[] } {
  const ops: WriteOperation[] = [];
  const outbox = { enqueue: jest.fn(async (op: Operation) => void ops.push(op as WriteOperation)) } as unknown as Outbox;
  return { outbox, ops };
}

describe("JobBillingRepository", () => {
  it("addLineItem inserts into job_items with the job link, no generated total, and returns the id", async () => {
    const { outbox, ops } = captureOutbox();
    const id = await new JobBillingRepository(outbox, seqIds(), fixedTime()).addLineItem({ jobId: "j1", name: "Labour", quantity: 2, unitPrice: 90, pricingItemId: "p1" });
    expect(id).toBe("id-1");
    expect(ops[0]).toMatchObject({ table: "job_items", op: "insert", rowId: "id-1" });
    expect(ops[0].payload).toEqual({ job_id: "j1", name: "Labour", description: null, quantity: 2, unit_price: 90, pricing_item_id: "p1" });
    expect(ops[0].payload).not.toHaveProperty("total");
  });

  it("removeLineItem enqueues a delete", async () => {
    const { outbox, ops } = captureOutbox();
    await new JobBillingRepository(outbox, seqIds(), fixedTime()).removeLineItem("li-1");
    expect(ops[0]).toMatchObject({ table: "job_items", op: "delete", rowId: "li-1" });
  });

  it("addExpense (no receipt) inserts a plain job_expenses row with entered_by and no attachment", async () => {
    const { outbox, ops } = captureOutbox();
    const res = await new JobBillingRepository(outbox, seqIds(), fixedTime()).addExpense({
      jobId: "j1",
      enteredBy: "u1",
      supplierName: "Reece Plumbing",
      category: "materials",
      amount: 120.5,
      gstAmount: 12.05,
    });
    expect(res).toEqual({ id: "id-1", receiptStoragePath: null });
    const w = ops[0];
    expect(w).toMatchObject({ table: "job_expenses", op: "insert", aggregate: "job_expense", rowId: "id-1" });
    expect(w.attachmentLocalPath).toBeUndefined();
    expect(w.attachmentPathField).toBeUndefined();
    expect(w.payload).toEqual({
      job_id: "j1",
      supplier_name: "Reece Plumbing",
      category: "materials",
      description: null,
      invoice_number: null,
      invoice_date: null,
      amount: 120.5,
      gst_amount: 12.05,
      cost_center_id: null,
      entered_by: "u1",
    });
    // no receipt columns, no transport bucket, no generated created_at
    expect(w.payload).not.toHaveProperty("receipt_storage_path");
    expect(w.payload).not.toHaveProperty("bucket");
  });

  it("addExpense allocates to a PO cost-centre stage when one is chosen (Q18)", async () => {
    const { outbox, ops } = captureOutbox();
    await new JobBillingRepository(outbox, seqIds(), fixedTime()).addExpense({
      jobId: "j1",
      enteredBy: "u1",
      supplierName: "Reece Plumbing",
      category: "materials",
      amount: 100,
      gstAmount: 10,
      costCenterId: "cc-3",
    });
    expect(ops[0].payload).toMatchObject({ cost_center_id: "cc-3" });
  });

  it("addExpense (with receipt) uploads before the row: derives an idempotent receipt key from rowId, bucket transport-only", async () => {
    const { outbox, ops } = captureOutbox();
    const res = await new JobBillingRepository(outbox, seqIds(), fixedTime()).addExpense({
      jobId: "j1",
      enteredBy: "u1",
      supplierName: "Bunnings",
      category: "materials",
      description: "Fittings",
      invoiceNumber: "INV-7",
      invoiceDate: "2026-07-20",
      amount: 80,
      gstAmount: 8,
      receipt: { localUri: "file:///doc/outbox/r.jpg" },
    });
    expect(res).toEqual({ id: "id-1", receiptStoragePath: "j1/expense-id-1.jpg" });
    const w = ops[0];
    expect(w.attachmentLocalPath).toBe("file:///doc/outbox/r.jpg");
    expect(w.attachmentPathField).toBe("receipt_storage_path");
    expect(w.payload).toMatchObject({
      job_id: "j1",
      supplier_name: "Bunnings",
      description: "Fittings",
      invoice_number: "INV-7",
      invoice_date: "2026-07-20",
      amount: 80,
      gst_amount: 8,
      entered_by: "u1",
      bucket: "job-documents",
      receipt_storage_path: "j1/expense-id-1.jpg",
    });
  });

  it("addExpense honours a non-default receipt extension in the object key", async () => {
    const { outbox, ops } = captureOutbox();
    const res = await new JobBillingRepository(outbox, seqIds(), fixedTime()).addExpense({
      jobId: "j2",
      enteredBy: "u1",
      supplierName: "S",
      category: "other",
      amount: 1,
      gstAmount: 0,
      receipt: { localUri: "file:///doc/outbox/r.pdf", ext: "pdf" },
    });
    expect(res.receiptStoragePath).toBe("j2/expense-id-1.pdf");
    expect(ops[0].payload.receipt_storage_path).toBe("j2/expense-id-1.pdf");
  });

  it("removeExpense with a receipt carries the key + bucket + path field so the object is cleaned up", async () => {
    const { outbox, ops } = captureOutbox();
    await new JobBillingRepository(outbox, seqIds(), fixedTime()).removeExpense({ id: "exp-9", receiptStoragePath: "j1/expense-exp-9.jpg" });
    const w = ops[0];
    expect(w).toMatchObject({ table: "job_expenses", op: "delete", aggregate: "job_expense", rowId: "exp-9", attachmentPathField: "receipt_storage_path" });
    expect(w.payload).toEqual({ bucket: "job-documents", receipt_storage_path: "j1/expense-exp-9.jpg" });
  });

  it("removeExpense without a receipt enqueues a plain delete (no attachment field, no bucket)", async () => {
    const { outbox, ops } = captureOutbox();
    await new JobBillingRepository(outbox, seqIds(), fixedTime()).removeExpense({ id: "exp-3" });
    const w = ops[0];
    expect(w).toMatchObject({ table: "job_expenses", op: "delete", rowId: "exp-3" });
    expect(w.attachmentPathField).toBeUndefined();
    expect(w.payload).toEqual({});
  });
});
