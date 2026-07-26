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

// Offline-first write path for a job's billing line items (office/admin). The
// `total` column is DB-generated, so it's never sent. Expenses (with receipt
// uploads) are read-only for now — see Q18.
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
