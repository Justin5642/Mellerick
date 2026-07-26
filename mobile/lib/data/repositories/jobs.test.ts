import { JobsRepository } from "./jobs";
import type { Outbox } from "../outbox/outbox";
import type { IdGen } from "../ids";
import type { Operation, WriteOperation, SideEffectOperation } from "../outbox/types";
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
const sides = (ops: Operation[]) => ops.filter((o): o is SideEffectOperation => o.kind === "side_effect");
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

describe("JobsRepository.createJob", () => {
  it("inserts a job with a client-UUID PK, required fields only, and NO job_number (DB serial)", async () => {
    const { outbox, ops } = captureOutbox();
    const id = await makeRepo(outbox).createJob({ customerId: "c1", title: "Fix tap" });
    expect(id).toBe("id-1");
    const w = writes(ops)[0];
    expect(w).toMatchObject({ table: "jobs", op: "insert", aggregate: "job", rowId: "id-1" });
    expect(w.id).not.toBe(w.rowId); // op id distinct from row id
    expect(w.payload).toEqual({ customer_id: "c1", title: "Fix tap" });
    expect(w.payload).not.toHaveProperty("job_number");
    expect(sides(ops)).toHaveLength(0); // no schedule => no calendar sync
  });

  it("maps all optional fields to their columns", async () => {
    const { outbox, ops } = captureOutbox();
    await makeRepo(outbox).createJob({
      customerId: "c1",
      title: "Install",
      siteId: "s1",
      assignedTo: "tech-1",
      jobType: "installation",
      priority: "high",
      status: "scheduled",
      scheduledStartIso: "2026-08-01T00:00:00.000Z",
      scheduledEndIso: "2026-08-01T02:00:00.000Z",
      description: "New RPZD",
    });
    expect(writes(ops)[0].payload).toEqual({
      customer_id: "c1",
      title: "Install",
      site_id: "s1",
      assigned_to: "tech-1",
      job_type: "installation",
      priority: "high",
      status: "scheduled",
      scheduled_start: "2026-08-01T00:00:00.000Z",
      scheduled_end: "2026-08-01T02:00:00.000Z",
      description: "New RPZD",
    });
  });

  it("enqueues a coalesced calendar sync (gated on the insert) when scheduled", async () => {
    const { outbox, ops } = captureOutbox();
    await makeRepo(outbox).createJob({ customerId: "c1", title: "T", scheduledStartIso: "2026-08-01T00:00:00.000Z" });
    const insert = writes(ops)[0];
    const cal = sides(ops)[0];
    expect(cal.effect).toBe("sync-calendar");
    expect(cal.coalesceKey).toBe("sync-calendar:id-1");
    expect(cal.dependsOn).toBe(insert.id);
    expect(cal.payload).toEqual({ jobId: "id-1" });
  });
});
