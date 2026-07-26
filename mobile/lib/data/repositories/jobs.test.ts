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

describe("JobsRepository.createJobFromQuote", () => {
  it("creates a pending service job, copies quote items (gated on the job), and links the quote", async () => {
    const { outbox, ops } = captureOutbox();
    const jobId = await makeRepo(outbox).createJobFromQuote({
      quoteId: "q1",
      title: "New install",
      notes: "as quoted",
      customerId: "c1",
      siteId: "s1",
      createdBy: "u1",
      items: [{ name: "Labour", description: null, quantity: 2, unitPrice: 90 }],
    });
    expect(jobId).toBe("id-1");

    const jobW = writes(ops).find((w) => w.table === "jobs" && w.op === "insert")!;
    expect(jobW.rowId).toBe("id-1");
    expect(jobW.dependsOn).toBeNull();
    expect(jobW.payload).toEqual({ title: "New install", description: "as quoted", customer_id: "c1", site_id: "s1", job_type: "service", status: "pending", created_by: "u1" });
    expect(jobW.payload).not.toHaveProperty("job_number"); // DB serial

    const item = writes(ops).find((w) => w.table === "job_items")!;
    expect(item.dependsOn).toBe(jobW.id); // never before the job exists
    expect(item.payload).toMatchObject({ job_id: "id-1", name: "Labour", quantity: 2, unit_price: 90 });
    expect(item.payload).not.toHaveProperty("total"); // DB GENERATED

    const link = writes(ops).find((w) => w.table === "quotes")!;
    expect(link).toMatchObject({ op: "update", rowId: "q1" });
    expect(link.dependsOn).toBe(jobW.id);
    expect(link.payload).toEqual({ job_id: "id-1" });
  });

  it("converts a quote with no items (job + link only)", async () => {
    const { outbox, ops } = captureOutbox();
    await makeRepo(outbox).createJobFromQuote({ quoteId: "q2", title: "T", customerId: "c1", items: [] });
    expect(writes(ops).some((w) => w.table === "job_items")).toBe(false);
    expect(writes(ops).find((w) => w.table === "jobs")).toBeDefined();
    expect(writes(ops).find((w) => w.table === "quotes")!.payload).toEqual({ job_id: "id-1" });
  });
});
