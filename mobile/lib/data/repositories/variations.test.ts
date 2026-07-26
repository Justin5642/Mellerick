import { VariationsRepository } from "./variations";
import type { Outbox } from "../outbox/outbox";
import type { IdGen } from "../ids";
import type { Operation, WriteOperation } from "../outbox/types";
import type { TimeSource } from "../time";

function seqIds(): IdGen {
  let n = 0;
  return { newId: () => `id-${++n}` };
}
const fixedTime = (): TimeSource => ({ nowMs: () => 1_000, nowIso: () => "2026-07-27T02:00:00.000Z" });

function captureOutbox(): { outbox: Outbox; ops: WriteOperation[] } {
  const ops: WriteOperation[] = [];
  const outbox = { enqueue: jest.fn(async (op: Operation) => void ops.push(op as WriteOperation)) } as unknown as Outbox;
  return { outbox, ops };
}

describe("VariationsRepository", () => {
  it("priceAndApprove writes rate/quantity/total_amount + approval metadata (total = rate × qty)", async () => {
    const { outbox, ops } = captureOutbox();
    await new VariationsRepository(outbox, seqIds(), fixedTime()).priceAndApprove({
      id: "v1",
      rate: 120,
      quantity: 2.5,
      approvedBy: "u1",
      notes: "agreed on site",
    });
    expect(ops[0]).toMatchObject({ table: "job_variations", op: "update", aggregate: "job_variation", rowId: "v1" });
    expect(ops[0].payload).toEqual({
      rate: 120,
      quantity: 2.5,
      total_amount: 300,
      status: "approved",
      approved_by: "u1",
      approved_at: "2026-07-27T02:00:00.000Z",
      admin_notes: "agreed on site",
    });
  });

  it("priceAndApprove sends null admin_notes when no note is given", async () => {
    const { outbox, ops } = captureOutbox();
    await new VariationsRepository(outbox, seqIds(), fixedTime()).priceAndApprove({ id: "v1", rate: 50, quantity: 1, approvedBy: "u1" });
    expect(ops[0].payload).toMatchObject({ total_amount: 50, admin_notes: null });
  });

  it("reject writes rejected status + notes + approval metadata, and no money columns", async () => {
    const { outbox, ops } = captureOutbox();
    await new VariationsRepository(outbox, seqIds(), fixedTime()).reject({ id: "v2", approvedBy: "u1", notes: "not covered by scope" });
    expect(ops[0]).toMatchObject({ table: "job_variations", op: "update", aggregate: "job_variation", rowId: "v2" });
    expect(ops[0].payload).toEqual({
      status: "rejected",
      admin_notes: "not covered by scope",
      approved_by: "u1",
      approved_at: "2026-07-27T02:00:00.000Z",
    });
    expect(ops[0].payload).not.toHaveProperty("rate");
    expect(ops[0].payload).not.toHaveProperty("total_amount");
  });
});
