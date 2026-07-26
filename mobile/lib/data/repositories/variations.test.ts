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

  it("submitVariation (tech) inserts WITHOUT any money/status column and returns the row id", async () => {
    const { outbox, ops } = captureOutbox();
    const { id } = await new VariationsRepository(outbox, seqIds(), fixedTime()).submitVariation({
      jobId: "job1",
      variationTypeId: "vt1",
      customName: null,
      description: "extra trenching",
      quantity: 3,
      unit: "m",
      loggedBy: "u1",
    });
    expect(id).toBe("id-1");
    expect(ops[0]).toMatchObject({ table: "job_variations", op: "insert", aggregate: "job_variation", rowId: "id-1" });
    expect(ops[0].payload).toEqual({
      job_id: "job1",
      variation_type_id: "vt1",
      custom_name: null,
      description: "extra trenching",
      quantity: 3,
      unit: "m",
      photo_storage_path: null,
      logged_by: "u1",
      logged_at: "2026-07-27T02:00:00.000Z",
    });
    // The technician path must never send a rate, total, or a set status — pricing
    // is applied server-side by the apply_variation_pricing() trigger.
    expect(ops[0].payload).not.toHaveProperty("rate");
    expect(ops[0].payload).not.toHaveProperty("total_amount");
    expect(ops[0].payload).not.toHaveProperty("status");
    expect(ops[0].attachmentLocalPath).toBeUndefined();
  });

  it("submitVariation attaches a photo via the attachment queue (photo_storage_path derived from the row id)", async () => {
    const { outbox, ops } = captureOutbox();
    await new VariationsRepository(outbox, seqIds(), fixedTime()).submitVariation({
      jobId: "job1",
      variationTypeId: null,
      customName: "Rock removal",
      description: null,
      quantity: 1,
      unit: "unit",
      loggedBy: "u1",
      photo: { localUri: "file:///durable/v.jpg", ext: "jpg" },
    });
    expect(ops[0].attachmentLocalPath).toBe("file:///durable/v.jpg");
    expect(ops[0].attachmentPathField).toBe("photo_storage_path");
    expect(ops[0].payload).toMatchObject({ bucket: "job-photos", photo_storage_path: "job1/variations/id-1.jpg", custom_name: "Rock removal" });
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
