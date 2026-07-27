import type { Outbox } from "../outbox/outbox";
import type { IdGen } from "../ids";
import type { WriteOperation, SideEffectOperation } from "../outbox/types";
import { systemTime, type TimeSource } from "../time";

// Offline-first schedule dispatch (office/admin), mirroring the web schedule
// board's drag-to-reassign and drag-to-reschedule (components/schedule/
// team-schedule-view.tsx). Each change is a durable `job` update routed through
// the outbox, followed by a coalesced best-effort calendar resync. Reassign and
// reschedule are separate (preserve-on-update) — exactly the web's two update
// paths — so a reassign never clobbers the times and vice-versa.
export class ScheduleRepository {
  constructor(
    private outbox: Outbox,
    private ids: IdGen,
    private time: TimeSource = systemTime
  ) {}

  /** Assign (or unassign, with null) a job to a technician. */
  async reassign(jobId: string, assignedTo: string | null): Promise<void> {
    await this.updateJob(jobId, { assigned_to: assignedTo });
  }

  /** Move a job to new start/end instants (compute them with computeReschedule). */
  async reschedule(jobId: string, scheduledStartIso: string, scheduledEndIso: string | null): Promise<void> {
    await this.updateJob(jobId, { scheduled_start: scheduledStartIso, scheduled_end: scheduledEndIso });
  }

  private async updateJob(jobId: string, payload: Record<string, unknown>): Promise<void> {
    const opId = this.ids.newId();
    const op: WriteOperation = {
      kind: "write",
      id: opId,
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
    // Resync the calendar once the job change has landed (coalesced per job).
    const cal: SideEffectOperation = {
      kind: "side_effect",
      id: this.ids.newId(),
      effect: "sync-calendar",
      coalesceKey: `sync-calendar:${jobId}`,
      payload: { jobId },
      dependsOn: opId,
      status: "pending",
      attempts: 0,
      nextAttemptAt: 0,
      createdAt: this.time.nowMs(),
    };
    await this.outbox.enqueue(cal);
  }
}
