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
  const outbox = {
    enqueue: jest.fn(async (op: Operation) => void ops.push(op)),
    // Every captured op is still queued (nothing drains here).
    pendingInsertOpId: jest.fn(
      async (table: string, rowId: string) =>
        ops.find((o) => o.kind === "write" && o.op === "insert" && o.table === table && o.rowId === rowId)?.id ?? null
    ),
  } as unknown as Outbox;
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

  it("updates the title alone without touching other columns", async () => {
    const { outbox, ops } = captureOutbox();
    await makeRepo(outbox).updateFields("j1", { title: "Renamed job" });
    expect(writes(ops)[0].payload).toEqual({ title: "Renamed job" });
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

  it("a crew of one is just assigned_to — no extra side effect", async () => {
    const { outbox, ops } = captureOutbox();
    await makeRepo(outbox).createJob({ customerId: "c1", title: "T", crewIds: ["tech-1"] });
    expect(writes(ops)[0].payload).toMatchObject({ assigned_to: "tech-1" });
    expect(sides(ops)).toHaveLength(0);
  });

  it("an empty crew is unassigned", async () => {
    const { outbox, ops } = captureOutbox();
    await makeRepo(outbox).createJob({ customerId: "c1", title: "T", crewIds: [] });
    expect(writes(ops)[0].payload).toMatchObject({ assigned_to: null });
    expect(sides(ops)).toHaveLength(0);
  });

  it("a crew of two: first is assigned_to, then set_job_assignments for all, then the calendar", async () => {
    const { outbox, ops } = captureOutbox();
    await makeRepo(outbox).createJob({
      customerId: "c1",
      title: "T",
      crewIds: ["tech-1", "tech-2", "tech-1"],
      scheduledStartIso: "2026-08-01T00:00:00.000Z",
    });
    const insert = writes(ops)[0];
    expect(insert.payload).toMatchObject({ assigned_to: "tech-1" });
    const [assign, cal] = sides(ops);
    expect(assign).toMatchObject({
      effect: "assign-technicians",
      coalesceKey: "assign-technicians:id-1",
      payload: { jobId: "id-1", staffIds: ["tech-1", "tech-2"] },
      dependsOn: insert.id,
    });
    expect(cal).toMatchObject({ effect: "sync-calendar", dependsOn: assign.id });
  });

  it("has no dependency when the customer and site are already on the server", async () => {
    const { outbox, ops } = captureOutbox();
    await makeRepo(outbox).createJob({ customerId: "c1", siteId: "s1", title: "T" });
    expect(writes(ops)[0].dependsOn).toBeUndefined();
  });

  it("waits for a site still queued on the phone", async () => {
    const { outbox, ops } = captureOutbox();
    const queuedSite = { kind: "write", id: "op-site", rowId: "s-new", op: "insert", table: "sites", status: "pending" } as WriteOperation;
    ops.push(queuedSite);
    await makeRepo(outbox).createJob({ customerId: "c1", siteId: "s-new", title: "T" });
    expect(writes(ops)[1]).toMatchObject({ table: "jobs", dependsOn: "op-site" });
  });

  it("waits for a customer still queued on the phone when there is no queued site", async () => {
    const { outbox, ops } = captureOutbox();
    ops.push({ kind: "write", id: "op-cust", rowId: "c-new", op: "insert", table: "customers", status: "pending" } as WriteOperation);
    await makeRepo(outbox).createJob({ customerId: "c-new", title: "T" });
    expect(writes(ops)[1]).toMatchObject({ table: "jobs", dependsOn: "op-cust" });
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

  it("queues the quote-value PO as a server side effect after the quote link, never a purchase_orders write", async () => {
    const { outbox, ops } = captureOutbox();
    await makeRepo(outbox).createJobFromQuote({
      quoteId: "q1",
      title: "T",
      customerId: "c1",
      items: [{ name: "Pipe", description: null, quantity: 1, unitPrice: 500 }],
    });
    // The job number is a DB serial the phone doesn't know yet, so the PO is
    // numbered (and valued, from the quote) on the server.
    expect(writes(ops).some((w) => w.table === "purchase_orders")).toBe(false);
    const link = writes(ops).find((w) => w.table === "quotes")!;
    const po = sides(ops).find((o) => o.effect === "quote-po")!;
    expect(po).toMatchObject({ coalesceKey: "quote-po:id-1", dependsOn: link.id });
    expect(po.payload).toEqual({ jobId: "id-1", quoteId: "q1", poId: expect.any(String) });
    // A client id of its own, so a retry finds the PO it already made.
    const used = ops.flatMap((o) => (o.kind === "write" ? [o.id, o.rowId] : [o.id]));
    expect(used).not.toContain(po.payload.poId);
    expect(ops[ops.length - 1]).toBe(po);
  });
});
