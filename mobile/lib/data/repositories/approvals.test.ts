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

// Approving moved to the server (mobile/lib/approveJob.ts, audit 15 Nov 2026);
// the gating and invoice-building cases it had here now live with
// lib/approve-job.ts on the web side.
