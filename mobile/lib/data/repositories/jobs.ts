import type { Outbox } from "../outbox/outbox";
import type { IdGen } from "../ids";
import type { WriteOperation } from "../outbox/types";
import { systemTime, type TimeSource } from "../time";

export interface JobFieldsInput {
  status?: string;
  priority?: string;
  jobType?: string;
  description?: string | null;
  notes?: string | null;
}

// Offline-first edits to a job's own fields (status / priority / type /
// description / internal notes). Preserve-on-update: ONLY the fields explicitly
// provided are written, so a status change never wipes the description and
// vice-versa. Assignee + schedule live in ScheduleRepository (the schedule
// board's concern); billing/approval flags have their own repositories.
export class JobsRepository {
  constructor(
    private outbox: Outbox,
    private ids: IdGen,
    private time: TimeSource = systemTime
  ) {}

  /** Update only the provided fields. No-op if nothing was provided. */
  async updateFields(jobId: string, fields: JobFieldsInput): Promise<void> {
    const payload: Record<string, unknown> = {};
    if (fields.status !== undefined) payload.status = fields.status;
    if (fields.priority !== undefined) payload.priority = fields.priority;
    if (fields.jobType !== undefined) payload.job_type = fields.jobType;
    if (fields.description !== undefined) payload.description = fields.description;
    if (fields.notes !== undefined) payload.notes = fields.notes;
    if (Object.keys(payload).length === 0) return;

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
