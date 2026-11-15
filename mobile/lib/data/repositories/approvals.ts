import type { Outbox } from "../outbox/outbox";
import type { IdGen } from "../ids";
import type { WriteOperation, SideEffectOperation } from "../outbox/types";
import { systemTime, type TimeSource } from "../time";
import type { FinanceRepository } from "./finance";

// Offline-first write path for sending a job back to the technician from the
// admin Approvals screen, through the durable outbox.
//
// APPROVING is not here any more (audit, 15 Nov 2026): it built the invoice from
// line items alone and dropped clocked hours. It now runs on the server, the
// same path as the web — see mobile/lib/approveJob.ts.
export class ApprovalsRepository {
  constructor(
    private outbox: Outbox,
    private ids: IdGen,
    private finance: FinanceRepository,
    private time: TimeSource = systemTime
  ) {}

  // Send back to the technician (admin). The UI requires a note. Reopens the job
  // (status in_progress), clears the admin/invoice flags, and resyncs the
  // calendar (coalesced, best-effort) — mirrors the web reject().
  async sendBackJob(input: { jobId: string; note: string }): Promise<void> {
    await this.updateJob(input.jobId, {
      admin_status: "rejected",
      admin_notes: input.note,
      status: "in_progress",
      ready_to_invoice: false,
    });
    const cal: SideEffectOperation = {
      kind: "side_effect",
      id: this.ids.newId(),
      effect: "sync-calendar",
      coalesceKey: `sync-calendar:${input.jobId}`,
      payload: { jobId: input.jobId },
      status: "pending",
      attempts: 0,
      nextAttemptAt: 0,
      createdAt: this.time.nowMs(),
    };
    await this.outbox.enqueue(cal);
  }

  private async updateJob(jobId: string, payload: Record<string, unknown>): Promise<void> {
    const op: WriteOperation = {
      kind: "write",
      id: this.ids.newId(),
      rowId: jobId,
      aggregate: "job",
      op: "update",
      table: "jobs",
      payload,
      status: "pending",
      attempts: 0,
      nextAttemptAt: 0,
      createdAt: this.time.nowMs(),
    };
    await this.outbox.enqueue(op);
  }
}
