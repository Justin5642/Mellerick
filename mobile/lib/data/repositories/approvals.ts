import type { Outbox } from "../outbox/outbox";
import type { IdGen } from "../ids";
import type { WriteOperation, SideEffectOperation } from "../outbox/types";
import { systemTime, type TimeSource } from "../time";
import { FinanceRepository, type LineItemInput } from "./finance";

export interface ApproveJobInput {
  jobId: string;
  customerId: string;
  jobNumber: number;
  jobTitle: string;
  /** An invoice already linked to this job, if any (dup guard) — id or null. */
  existingInvoiceId?: string | null;
  /** The job's built-up line items (job_items) to seed the invoice from. */
  items: LineItemInput[];
  adminNotes?: string | null;
}

// Offline-first write path for the admin Approvals workflow, mirroring the web
// (app/dashboard/approvals). Approving a completed job auto-creates a DRAFT
// invoice from its line items (unless one already exists) then marks the job
// approved; sending it back reopens it for the technician. All writes route
// through the durable outbox. NOTE: the web's Xero auto-push on approve is an
// EXTERNAL GATE (the push-invoice route is cookie-only and rejects a mobile
// Bearer token) — not attempted here; the invoice is created as a draft and can
// be pushed from the web.
export class ApprovalsRepository {
  constructor(
    private outbox: Outbox,
    private ids: IdGen,
    private finance: FinanceRepository,
    private time: TimeSource = systemTime
  ) {}

  // Approve (admin). If no invoice exists for the job yet and it has line items,
  // auto-create a draft invoice (+ items) from them; then mark the job approved.
  // ready_to_invoice stays true ONLY when no invoice was created/found, so a job
  // with no line items still surfaces in the manual "Ready to Invoice" queue —
  // exactly the web's `ready_to_invoice: !invoiceId`.
  async approveJob(input: ApproveJobInput): Promise<{ invoiceId: string | null; invoiceCreated: boolean }> {
    let invoiceId = input.existingInvoiceId ?? null;
    let invoiceCreated = false;
    if (!invoiceId && input.items.length > 0) {
      invoiceId = await this.finance.createInvoice({
        customerId: input.customerId,
        jobId: input.jobId,
        title: `#${input.jobNumber} — ${input.jobTitle}`,
        items: input.items,
      });
      invoiceCreated = true;
    }
    await this.updateJob(input.jobId, {
      admin_status: "approved",
      admin_notes: input.adminNotes ?? null,
      ready_to_invoice: !invoiceId,
    });
    return { invoiceId, invoiceCreated };
  }

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
