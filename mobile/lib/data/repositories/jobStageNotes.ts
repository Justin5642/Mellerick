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

  /** Queue an edit of a stage note's text. Only `content` changes — never the
   * stage, author or job. RLS (0074) decides who may: the author, or any
   * office/admin. A refusal affects no rows, which the gateway turns into a
   * failure, so it shows in "not synced" rather than vanishing. */
  async update(input: { id: string; content: string }): Promise<void> {
    const write: WriteOperation = {
      kind: "write",
      id: this.ids.newId(),
      rowId: input.id,
      aggregate: "job_stage_note",
      op: "update",
      table: "job_stage_notes",
      payload: { content: input.content },
      status: "pending",
      attempts: 0,
      nextAttemptAt: 0,
      createdAt: this.time.nowMs(),
    };
    await this.outbox.enqueue(write);
  }

  /** Queue a stage note delete (no attachment). Same RLS rule as update; the
   * gateway's delete checks whether the row survived, so a refusal is surfaced. */
  async remove(input: { id: string }): Promise<void> {
    const write: WriteOperation = {
      kind: "write",
      id: this.ids.newId(),
      rowId: input.id,
      aggregate: "job_stage_note",
      op: "delete",
      table: "job_stage_notes",
      payload: {},
      status: "pending",
      attempts: 0,
      nextAttemptAt: 0,
      createdAt: this.time.nowMs(),
    };
    await this.outbox.enqueue(write);
  }
}
