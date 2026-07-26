import type { Outbox } from "../outbox/outbox";
import type { IdGen } from "../ids";
import type { WriteOp, WriteOperation, SideEffectOperation } from "../outbox/types";
import { systemTime, type TimeSource } from "../time";

// Re-exported for back-compat with existing importers of these from here.
export { systemTime, type TimeSource };

// Pure: worked hours between two ISO timestamps, rounded to 2dp; null if the
// end is not strictly after the start. Mirrors the web/mobile inline math
// (see mobile/components/job/time.tsx) so billing stays identical.
export function hoursBetween(startIso: string, endIso: string): number | null {
  const ms = new Date(endIso).getTime() - new Date(startIso).getTime();
  if (ms <= 0) return null;
  return Math.round((ms / 3600000) * 100) / 100;
}

export interface ManualEntryInput {
  jobId: string;
  staffId: string;
  entryType: "work" | "travel";
  clockInIso: string;
  clockOutIso: string | null;
  costCenterId: string | null;
}

export interface EditEntryInput {
  entryId: string;
  editorId: string;
  clockInIso: string;
  clockOutIso: string | null;
  costCenterId: string | null;
}

// Offline-first replacement for the direct-Supabase writes in JobTimeTab. Every
// mutation becomes a durable outbox operation (client-UUID PK => idempotent
// replay), and — exactly where the web app calls syncBilling — a coalesced
// sync-billing side-effect that depends on the write so it never fires before
// the row it bills for exists. Reads still come from repositories over the
// (RLS-protected) Supabase client; this class owns the write path only.
export class TimeEntriesRepository {
  constructor(
    private outbox: Outbox,
    private ids: IdGen,
    private time: TimeSource = systemTime
  ) {}

  /** Clock in now. Returns the new entry's client-generated id. */
  async clockIn(input: { jobId: string; staffId: string }): Promise<string> {
    const rowId = this.ids.newId();
    const opId = await this.enqueueWrite(rowId, "insert", {
      job_id: input.jobId,
      staff_id: input.staffId,
      clock_in: this.time.nowIso(),
      auto_clocked: false,
    });
    await this.enqueueBillingSync(rowId, opId);
    return rowId;
  }

  /** Clock out an open entry now, computing hours from its clock-in. */
  async clockOut(input: { entryId: string; clockInIso: string }): Promise<void> {
    const clockOutIso = this.time.nowIso();
    const opId = await this.enqueueWrite(input.entryId, "update", {
      clock_out: clockOutIso,
      hours: hoursBetween(input.clockInIso, clockOutIso),
    });
    await this.enqueueBillingSync(input.entryId, opId);
  }

  /** Add a backdated manual entry (used when auto clock-in/out didn't fire). */
  async addManual(input: ManualEntryInput): Promise<string> {
    const rowId = this.ids.newId();
    const opId = await this.enqueueWrite(rowId, "insert", {
      job_id: input.jobId,
      staff_id: input.staffId,
      entry_type: input.entryType,
      clock_in: input.clockInIso,
      clock_out: input.clockOutIso,
      hours: input.clockOutIso ? hoursBetween(input.clockInIso, input.clockOutIso) : null,
      cost_center_id: input.costCenterId,
      auto_clocked: false,
      edited_by: input.staffId,
      edited_at: this.time.nowIso(),
    });
    await this.enqueueBillingSync(rowId, opId);
    return rowId;
  }

  /** Correct an existing entry's start/end/stage. */
  async editEntry(input: EditEntryInput): Promise<void> {
    const opId = await this.enqueueWrite(input.entryId, "update", {
      clock_in: input.clockInIso,
      clock_out: input.clockOutIso,
      hours: input.clockOutIso ? hoursBetween(input.clockInIso, input.clockOutIso) : null,
      cost_center_id: input.costCenterId,
      edited_by: input.editorId,
      edited_at: this.time.nowIso(),
    });
    await this.enqueueBillingSync(input.entryId, opId);
  }

  /** Assign an entry to a PO cost-center stage. Deliberately NO billing resync:
   * the generated Labour/Call-Out items are derived from hours only (see
   * lib/labour-billing-sync.ts — it never reads cost_center_id), so reassigning
   * a stage cannot change what's billed. Verified for Q6. */
  async assignCostCenter(entryId: string, costCenterId: string | null): Promise<void> {
    await this.enqueueWrite(entryId, "update", { cost_center_id: costCenterId });
  }

  /**
   * Delete an entry, then reconcile the job's billing (Q6).
   *
   * Deleting a billed entry used to leave its auto-generated "Labour" line item
   * behind — the job stayed billed for hours that no longer exist. We therefore
   * resync, but keyed on the JOB, not the entry: the entry-keyed endpoint
   * resolves the job FROM the entry, so once the row is gone it would 404. The
   * job-level route recomputes every remaining entry, so the stale line clears.
   * `jobId` is optional only for backwards compatibility; always pass it.
   */
  async remove(entryId: string, jobId?: string): Promise<void> {
    const opId = await this.enqueueWrite(entryId, "delete", {});
    if (jobId) await this.enqueueJobBillingSync(jobId, opId);
  }

  private async enqueueWrite(
    rowId: string,
    op: WriteOp,
    payload: Record<string, unknown>
  ): Promise<string> {
    const id = this.ids.newId();
    const write: WriteOperation = {
      kind: "write",
      id,
      rowId,
      aggregate: "time_entry",
      op,
      table: "time_entries",
      payload,
      status: "pending",
      attempts: 0,
      nextAttemptAt: 0,
      createdAt: this.time.nowMs(),
    };
    await this.outbox.enqueue(write);
    return id;
  }

  // Job-level reconcile, gated on the write that triggered it. Coalesced per job
  // so several deletes in one offline session collapse to a single resync.
  private async enqueueJobBillingSync(jobId: string, dependsOn: string): Promise<void> {
    const op: SideEffectOperation = {
      kind: "side_effect",
      id: this.ids.newId(),
      effect: "sync-job-billing",
      coalesceKey: `sync-job-billing:${jobId}`,
      payload: { jobId },
      dependsOn,
      status: "pending",
      attempts: 0,
      nextAttemptAt: 0,
      createdAt: this.time.nowMs(),
    };
    await this.outbox.enqueue(op);
  }

  private async enqueueBillingSync(entryId: string, dependsOn: string): Promise<void> {
    const op: SideEffectOperation = {
      kind: "side_effect",
      id: this.ids.newId(),
      effect: "sync-billing",
      coalesceKey: `sync-billing:${entryId}`,
      payload: { entryId },
      dependsOn,
      status: "pending",
      attempts: 0,
      nextAttemptAt: 0,
      createdAt: this.time.nowMs(),
    };
    await this.outbox.enqueue(op);
  }
}
