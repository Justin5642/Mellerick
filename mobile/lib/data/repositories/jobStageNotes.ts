import type { Outbox } from "../outbox/outbox";
import type { IdGen } from "../ids";
import type { WriteOperation } from "../outbox/types";
import { systemTime, type TimeSource } from "../time";

// Offline-first write path for stage-based job notes — same shape as
// JobNotesRepository (a single plain insert, no attachment, no side-effect),
// just against job_stage_notes with a `stage` column. The row PK is a client
// UUID so replay upserts idempotently. created_at is left to the DB default.
export class JobStageNotesRepository {
  constructor(
    private outbox: Outbox,
    private ids: IdGen,
    private time: TimeSource = systemTime
  ) {}

  /** Queue a stage note. Returns the new row id for the optimistic row. */
  async add(input: { jobId: string; stage: string; authorId: string; content: string }): Promise<string> {
    const rowId = this.ids.newId();
    const write: WriteOperation = {
      kind: "write",
      id: this.ids.newId(),
      rowId,
      aggregate: "job_stage_note",
      op: "insert",
      table: "job_stage_notes",
      payload: {
        job_id: input.jobId,
        stage: input.stage,
        author_id: input.authorId,
        content: input.content,
      },
      status: "pending",
      attempts: 0,
      nextAttemptAt: 0,
      createdAt: this.time.nowMs(),
    };
    await this.outbox.enqueue(write);
    return rowId;
  }
}
