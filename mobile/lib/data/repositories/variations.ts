import type { Outbox } from "../outbox/outbox";
import type { IdGen } from "../ids";
import type { WriteOperation } from "../outbox/types";
import { systemTime, type TimeSource } from "../time";

// Office/admin variation pricing + approval, mirroring the web job "Variations"
// tab (components/job/job-variations.tsx priceAndApprove/reject). A custom
// (non-preset) variation a technician logs lands as `pending_approval` with no
// rate; the office prices it (rate × quantity → total_amount) and approves, or
// rejects it with a note. Money-bearing, so this path is office/admin-only (the
// job_variations base table's rate/total_amount are office/admin RLS; techs read
// the rate-stripped job_variations_public view). All durable via the outbox.
export class VariationsRepository {
  constructor(
    private outbox: Outbox,
    private ids: IdGen,
    private time: TimeSource = systemTime
  ) {}

  /**
   * Technician: log a variation (offline-durable). Mirrors the web/tech insert —
   * it NEVER sends rate / total_amount / status: pricing is applied server-side
   * by the apply_variation_pricing() trigger (auto-approve types get their preset
   * rate; custom ones stay pending_approval for the office). An optional photo
   * rides the attachment queue (uploaded before the row, keyed by the client
   * rowId under `<jobId>/variations/<rowId>` in job-photos → idempotent replay).
   */
  async submitVariation(input: {
    jobId: string;
    variationTypeId: string | null;
    customName: string | null;
    description: string | null;
    quantity: number;
    unit: string;
    loggedBy: string;
    photo?: { localUri: string; ext?: string } | null;
  }): Promise<{ id: string }> {
    const rowId = this.ids.newId();
    const photoPath = input.photo ? `${input.jobId}/variations/${rowId}.${input.photo.ext ?? "jpg"}` : null;
    const payload: Record<string, unknown> = {
      job_id: input.jobId,
      variation_type_id: input.variationTypeId,
      custom_name: input.customName,
      description: input.description,
      quantity: input.quantity,
      unit: input.unit,
      photo_storage_path: photoPath,
      logged_by: input.loggedBy,
      logged_at: this.time.nowIso(),
    };
    if (input.photo) payload.bucket = "job-photos"; // transport-only; stripped before the row write
    const op: WriteOperation = {
      kind: "write",
      id: this.ids.newId(),
      rowId,
      aggregate: "job_variation",
      op: "insert",
      table: "job_variations",
      payload,
      ...(input.photo ? { attachmentLocalPath: input.photo.localUri, attachmentPathField: "photo_storage_path" } : {}),
      status: "pending",
      attempts: 0,
      nextAttemptAt: 0,
      createdAt: this.time.nowMs(),
    };
    await this.outbox.enqueue(op);
    return { id: rowId };
  }

  /** Price a pending variation and approve it (total = rate × quantity). */
  async priceAndApprove(input: { id: string; rate: number; quantity: number; approvedBy: string; notes?: string | null }): Promise<void> {
    await this.update(input.id, {
      rate: input.rate,
      quantity: input.quantity,
      total_amount: input.rate * input.quantity,
      status: "approved",
      approved_by: input.approvedBy,
      approved_at: this.time.nowIso(),
      admin_notes: input.notes?.trim() ? input.notes.trim() : null,
    });
  }

  /** Reject a pending variation (no pricing applied). */
  async reject(input: { id: string; approvedBy: string; notes?: string | null }): Promise<void> {
    await this.update(input.id, {
      status: "rejected",
      admin_notes: input.notes?.trim() ? input.notes.trim() : null,
      approved_by: input.approvedBy,
      approved_at: this.time.nowIso(),
    });
  }

  private async update(rowId: string, payload: Record<string, unknown>): Promise<void> {
    const op: WriteOperation = {
      kind: "write",
      id: this.ids.newId(),
      rowId,
      aggregate: "job_variation",
      op: "update",
      table: "job_variations",
      payload,
      status: "pending",
      attempts: 0,
      nextAttemptAt: 0,
      createdAt: this.time.nowMs(),
    };
    await this.outbox.enqueue(op);
  }
}
