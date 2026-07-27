import type { Outbox } from "../outbox/outbox";
import type { IdGen } from "../ids";
import type { WriteOp, WriteOperation } from "../outbox/types";
import { systemTime, type TimeSource } from "../time";

export interface JobLineItemInput {
  jobId: string;
  name: string;
  description?: string | null;
  quantity: number;
  unitPrice: number;
  pricingItemId?: string | null;
}

// job_expenses.category is CHECK-constrained to exactly these values.
export type ExpenseCategory = "materials" | "subcontractor" | "equipment_hire" | "other";

export interface JobExpenseInput {
  jobId: string;
  enteredBy: string;
  supplierName: string;
  category: ExpenseCategory;
  description?: string | null;
  invoiceNumber?: string | null;
  invoiceDate?: string | null; // YYYY-MM-DD (local); DB column is `date`
  amount: number; // ex-GST, to match the invoice_items convention
  gstAmount: number;
  /** Optional PO cost-centre stage to allocate this spend to (null = Unassigned). */
  costCenterId?: string | null;
  /** Optional receipt/invoice file to attach (uploads before the row). */
  receipt?: { localUri: string; ext?: string } | null;
}

// Receipts share the web's private `job-documents` bucket (see migration 0023).
const RECEIPT_BUCKET = "job-documents";

// Offline-first write path for a job's billing line items AND expenses
// (office/admin). The `total` column is DB-generated, so it's never sent.
export class JobBillingRepository {
  constructor(
    private outbox: Outbox,
    private ids: IdGen,
    private time: TimeSource = systemTime
  ) {}

  async addLineItem(input: JobLineItemInput): Promise<string> {
    const id = this.ids.newId();
    await this.write("insert", id, {
      job_id: input.jobId,
      name: input.name,
      description: input.description ?? null,
      quantity: input.quantity,
      unit_price: input.unitPrice,
      pricing_item_id: input.pricingItemId ?? null,
      // total is a DB GENERATED column — never sent.
    });
    return id;
  }

  async removeLineItem(id: string): Promise<void> {
    await this.write("delete", id, {});
  }

  // Queue a job expense. With a receipt, the object uploads to Storage FIRST
  // (attachmentPathField → receipt_storage_path), then the row is written, so a
  // row never references a missing object. The object key is derived from the
  // client rowId (`${jobId}/expense-${rowId}.${ext}`) → replay re-uploads to the
  // same key (upsert) and re-inserts the same row: fully idempotent.
  async addExpense(input: JobExpenseInput): Promise<{ id: string; receiptStoragePath: string | null }> {
    const rowId = this.ids.newId();
    const receiptStoragePath = input.receipt ? `${input.jobId}/expense-${rowId}.${input.receipt.ext ?? "jpg"}` : null;
    const payload: Record<string, unknown> = {
      job_id: input.jobId,
      supplier_name: input.supplierName,
      category: input.category,
      description: input.description ?? null,
      invoice_number: input.invoiceNumber ?? null,
      invoice_date: input.invoiceDate ?? null,
      amount: input.amount,
      gst_amount: input.gstAmount,
      cost_center_id: input.costCenterId ?? null,
      entered_by: input.enteredBy,
      // total/created_at are DB-owned; never sent.
    };
    if (input.receipt) {
      payload.bucket = RECEIPT_BUCKET; // transport-only; stripped before the row write
      payload.receipt_storage_path = receiptStoragePath; // real column AND the object key
    }
    const write: WriteOperation = {
      kind: "write",
      id: this.ids.newId(),
      rowId,
      aggregate: "job_expense",
      op: "insert",
      table: "job_expenses",
      attachmentLocalPath: input.receipt ? input.receipt.localUri : undefined,
      attachmentPathField: input.receipt ? "receipt_storage_path" : undefined,
      payload,
      status: "pending",
      attempts: 0,
      nextAttemptAt: 0,
      createdAt: this.time.nowMs(),
    };
    await this.outbox.enqueue(write);
    return { id: rowId, receiptStoragePath };
  }

  // Queue an expense delete. If a receipt is attached, carry its key + bucket so
  // the processor removes the Storage object (best-effort) before the row.
  async removeExpense(input: { id: string; receiptStoragePath?: string | null }): Promise<void> {
    const payload: Record<string, unknown> = {};
    if (input.receiptStoragePath) {
      payload.bucket = RECEIPT_BUCKET;
      payload.receipt_storage_path = input.receiptStoragePath;
    }
    const write: WriteOperation = {
      kind: "write",
      id: this.ids.newId(),
      rowId: input.id,
      aggregate: "job_expense",
      op: "delete",
      table: "job_expenses",
      attachmentPathField: input.receiptStoragePath ? "receipt_storage_path" : undefined,
      payload,
      status: "pending",
      attempts: 0,
      nextAttemptAt: 0,
      createdAt: this.time.nowMs(),
    };
    await this.outbox.enqueue(write);
  }

  private async write(op: WriteOp, rowId: string, payload: Record<string, unknown>): Promise<string> {
    const id = this.ids.newId();
    const write: WriteOperation = {
      kind: "write",
      id,
      rowId,
      aggregate: "job_item",
      op,
      table: "job_items",
      payload,
      status: "pending",
      attempts: 0,
      nextAttemptAt: 0,
      createdAt: this.time.nowMs(),
    };
    await this.outbox.enqueue(write);
    return id;
  }
}
