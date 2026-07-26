import { JobsRepository } from "./jobs";
import type { Outbox } from "../outbox/outbox";
import type { IdGen } from "../ids";
import type { Operation, WriteOperation } from "../outbox/types";
import type { TimeSource } from "../time";

function seqIds(): IdGen {
  let n = 0;
  return { newId: () => `id-${++n}` };
}
const fixedTime = (ms = 1_000): TimeSource => ({ nowMs: () => ms, nowIso: () => "2026-07-26T00:00:00.000Z" });
function captureOutbox(): { outbox: Outbox; ops: Operation[] } {
  const ops: Operation[] = [];
  const outbox = { enqueue: jest.fn(async (op: Operation) => void ops.push(op)) } as unknown as Outbox;
  return { outbox, ops };
}
const writes = (ops: Operation[]) => ops.filter((o): o is WriteOperation => o.kind === "write");
const makeRepo = (outbox: Outbox) => new JobsRepository(outbox, seqIds(), fixedTime());

describe("JobsRepository.updateFields", () => {
  it("enqueues a job update with only the provided fields (preserve-on-update)", async () => {
    const { outbox, ops } = captureOutbox();
    await makeRepo(outbox).updateFields("j1", { status: "in_progress", priority: "high" });
    const w = writes(ops)[0];
    expect(w).toMatchObject({ table: "jobs", op: "update", aggregate: "job", rowId: "j1" });
    expect(w.payload).toEqual({ status: "in_progress", priority: "high" });
  });

  it("omits fields that weren't provided (a status change never wipes the description)", async () => {
    const { outbox, ops } = captureOutbox();
    await makeRepo(outbox).updateFields("j1", { status: "on_hold" });
    expect(writes(ops)[0].payload).toEqual({ status: "on_hold" });
    expect(writes(ops)[0].payload).not.toHaveProperty("description");
    expect(writes(ops)[0].payload).not.toHaveProperty("priority");
  });

  it("sends an explicit null to CLEAR a nullable field (description/notes)", async () => {
    const { outbox, ops } = captureOutbox();
    await makeRepo(outbox).updateFields("j1", { description: null, notes: "office note" });
    expect(writes(ops)[0].payload).toEqual({ description: null, notes: "office note" });
  });

  it("maps jobType to the job_type column", async () => {
    const { outbox, ops } = captureOutbox();
    await makeRepo(outbox).updateFields("j1", { jobType: "maintenance" });
    expect(writes(ops)[0].payload).toEqual({ job_type: "maintenance" });
  });

  it("is a no-op when no fields are provided (no empty update enqueued)", async () => {
    const { outbox, ops } = captureOutbox();
    await makeRepo(outbox).updateFields("j1", {});
    expect(ops).toHaveLength(0);
  });
});
