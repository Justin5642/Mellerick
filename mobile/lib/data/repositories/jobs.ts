import type { Outbox } from "../outbox/outbox";
import type { IdGen } from "../ids";
import type { WriteOperation, SideEffectOperation } from "../outbox/types";
import { systemTime, type TimeSource } from "../time";

export interface JobFieldsInput {
  status?: string;
  priority?: string;
  jobType?: string;
  description?: string | null;
  notes?: string | null;
}

export interface CreateJobInput {
  customerId: string;
  title: string;
  siteId?: string | null;
  assignedTo?: string | null;
  jobType?: string;
  priority?: string;
  status?: string;
  scheduledStartIso?: string | null;
  scheduledEndIso?: string | null;
  description?: string | null;
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

  // Create a new job (office/admin). job_number is a DB serial, so it's never
  // sent; the row PK is a client UUID for idempotent offline replay. When a
  // schedule is given, a coalesced calendar sync follows the insert. Only
  // customer_id + title are required (DB NOT NULL); the rest carry DB defaults.
  async createJob(input: CreateJobInput): Promise<string> {
    const rowId = this.ids.newId();
    const payload: Record<string, unknown> = { customer_id: input.customerId, title: input.title };
    if (input.siteId !== undefined) payload.site_id = input.siteId;
    if (input.assignedTo !== undefined) payload.assigned_to = input.assignedTo;
    if (input.jobType !== undefined) payload.job_type = input.jobType;
    if (input.priority !== undefined) payload.priority = input.priority;
    if (input.status !== undefined) payload.status = input.status;
    if (input.scheduledStartIso !== undefined) payload.scheduled_start = input.scheduledStartIso;
    if (input.scheduledEndIso !== undefined) payload.scheduled_end = input.scheduledEndIso;
    if (input.description !== undefined) payload.description = input.description;

    const insertId = this.ids.newId();
    const op: WriteOperation = {
      kind: "write",
      id: insertId,
      rowId,
      aggregate: "job",
      op: "insert",
      table: "jobs",
      payload,
      status: "pending",
      attempts: 0,
      nextAttemptAt: 0,
      createdAt: this.time.nowMs(),
    };
    await this.outbox.enqueue(op);

    if (input.scheduledStartIso) {
      const cal: SideEffectOperation = {
        kind: "side_effect",
        id: this.ids.newId(),
        effect: "sync-calendar",
        coalesceKey: `sync-calendar:${rowId}`,
        payload: { jobId: rowId },
        dependsOn: insertId,
        status: "pending",
        attempts: 0,
        nextAttemptAt: 0,
        createdAt: this.time.nowMs(),
      };
      await this.outbox.enqueue(cal);
    }
    return rowId;
  }

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
