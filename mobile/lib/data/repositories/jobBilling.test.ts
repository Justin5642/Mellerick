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
});
