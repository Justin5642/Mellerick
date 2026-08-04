import { ApprovalsRepository } from "./approvals";
import { FinanceRepository } from "./finance";
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
const jobUpdate = (ops: Operation[]) => writes(ops).find((w) => w.table === "jobs" && w.op === "update");
const invoiceInsert = (ops: Operation[]) => writes(ops).find((w) => w.table === "invoices" && w.op === "insert");

function makeRepo(outbox: Outbox) {
  const ids = seqIds(); // ONE shared id source across finance + approvals
  const finance = new FinanceRepository(outbox, ids, fixedTime());
  return new ApprovalsRepository(outbox, ids, finance, fixedTime());
}

describe("ApprovalsRepository", () => {
  it("approveJob with line items and no existing invoice: creates a draft invoice + items, marks approved, ready_to_invoice=false", async () => {
    const { outbox, ops } = captureOutbox();
    const res = await makeRepo(outbox).approveJob({
      jobId: "j1",
      customerId: "c1",
      jobNumber: 42,
      jobTitle: "Fix tap",
      existingInvoiceId: null,
      items: [{ name: "Labour", quantity: 2, unitPrice: 90 }],
      adminNotes: "looks good",
    });

    const inv = invoiceInsert(ops)!;
    expect(inv).toBeDefined();
    expect(inv.payload).toMatchObject({
      customer_id: "c1",
      job_id: "j1",
      title: "#42 — Fix tap",
      status: "draft",
      subtotal: 180,
      tax_amount: 18,
      total: 198,
    });
    // an invoice_items row was enqueued, gated on the invoice row
    const item = writes(ops).find((w) => w.table === "invoice_items");
    expect(item).toBeDefined();
    expect(item!.dependsOn).toBe(inv.id);

    const job = jobUpdate(ops)!;
    expect(job.aggregate).toBe("job");
    expect(job.rowId).toBe("j1");
    expect(job.payload).toEqual({ admin_status: "approved", admin_notes: "looks good", ready_to_invoice: false });

    expect(res.invoiceCreated).toBe(true);
    expect(res.invoiceId).toBe(inv.rowId);
  });

  it("approveJob when an invoice already exists: creates NO invoice, still marks approved with ready_to_invoice=false", async () => {
    const { outbox, ops } = captureOutbox();
    const res = await makeRepo(outbox).approveJob({
      jobId: "j2",
      customerId: "c1",
      jobNumber: 7,
      jobTitle: "X",
      existingInvoiceId: "inv-existing",
      items: [{ name: "Labour", quantity: 1, unitPrice: 50 }], // ignored — invoice exists
    });
    expect(invoiceInsert(ops)).toBeUndefined();
    expect(writes(ops).some((w) => w.table === "invoice_items")).toBe(false);
    expect(jobUpdate(ops)!.payload).toEqual({ admin_status: "approved", admin_notes: null, ready_to_invoice: false });
    expect(res).toEqual({ invoiceId: "inv-existing", invoiceCreated: false });
  });

  it("approveJob with no line items and no invoice: no invoice, ready_to_invoice=true (surfaces for manual invoicing)", async () => {
    const { outbox, ops } = captureOutbox();
    const res = await makeRepo(outbox).approveJob({
      jobId: "j3",
      customerId: "c1",
      jobNumber: 9,
      jobTitle: "Y",
      existingInvoiceId: null,
      items: [],
    });
    expect(invoiceInsert(ops)).toBeUndefined();
    expect(jobUpdate(ops)!.payload).toEqual({ admin_status: "approved", admin_notes: null, ready_to_invoice: true });
    expect(res).toEqual({ invoiceId: null, invoiceCreated: false });
  });

  it("sendBackJob reopens the job, clears the flags, and enqueues a coalesced sync-calendar side-effect", async () => {
    const { outbox, ops } = captureOutbox();
    await makeRepo(outbox).sendBackJob({ jobId: "j1", note: "Add before/after photos" });

    expect(jobUpdate(ops)!.payload).toEqual({
      admin_status: "rejected",
      admin_notes: "Add before/after photos",
      status: "in_progress",
      ready_to_invoice: false,
    });
    const cal = sides(ops)[0];
    expect(cal.effect).toBe("sync-calendar");
    expect(cal.coalesceKey).toBe("sync-calendar:j1");
    expect(cal.payload).toEqual({ jobId: "j1" });
    // no invoice touched on a send-back
    expect(invoiceInsert(ops)).toBeUndefined();
  });
});

// APPROVING A JOB MUST NOT OUTLIVE THE INVOICE IT CREATED.
//
// approveJob enqueues two writes: create the invoice, then mark the job
// approved with ready_to_invoice = false. They were independent, so if the
// invoice op dead-lettered the job update still landed — and the job dropped
// out of BOTH the approvals queue (it is approved) and the Ready-to-Invoice
// list (the flag is cleared), with no invoice anywhere. Completed work, billed
// to nobody, visible on no screen.
//
// The dependency is expressed the way this codebase already expresses it: the
// follow-up write carries dependsOn = the invoice op, so the queue will not run
// it until the invoice row has actually landed.
describe("approveJob — the job update is gated on the invoice", () => {
  const input = {
    jobId: "job-1",
    jobNumber: 833,
    jobTitle: "Test",
    customerId: "cust-1",
    items: [{ name: "Labour", quantity: 1, unitPrice: 100 }],
    adminNotes: null,
    existingInvoiceId: null,
  };

  it("makes the jobs update depend on the invoice insert", async () => {
    const { outbox, ops } = captureOutbox();
    await makeRepo(outbox).approveJob(input as never);

    const inv = invoiceInsert(ops);
    const job = jobUpdate(ops);
    expect(inv).toBeDefined();
    expect(job?.dependsOn).toBe(inv?.id);
  });

  it("still approves with no dependency when there is nothing to invoice", async () => {
    // No items => no invoice is created, so there is nothing to wait for and
    // gating on a non-existent op would strand the approval forever.
    const { outbox, ops } = captureOutbox();
    await makeRepo(outbox).approveJob({ ...input, items: [] } as never);

    expect(invoiceInsert(ops)).toBeUndefined();
    expect(jobUpdate(ops)?.dependsOn).toBeUndefined();
  });

  it("does not gate when an invoice already exists", async () => {
    const { outbox, ops } = captureOutbox();
    await makeRepo(outbox).approveJob({ ...input, existingInvoiceId: "inv-existing" } as never);

    expect(invoiceInsert(ops)).toBeUndefined();
    expect(jobUpdate(ops)?.dependsOn).toBeUndefined();
  });
});
