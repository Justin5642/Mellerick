import type { Outbox } from "../outbox/outbox";
import type { IdGen } from "../ids";
import type { WriteOperation } from "../outbox/types";
import { systemTime, type TimeSource } from "../time";

// Offline-first write path for job notes — the simplest vertical: a single
// insert, no attachment, no dependent side-effect (the "Polish with AI" button
// is a synchronous pre-save call handled in the screen, not an outbox op). The
// row PK is a client UUID so replay upserts idempotently. created_at is left to
// the DB default (sending a client value would skew the created_at-desc order).
export class JobNotesRepository {
  constructor(
    private outbox: Outbox,
    private ids: IdGen,
    private time: TimeSource = systemTime
  ) {}

  /** Queue a note. Returns the new row id for the optimistic row. */
  async add(input: { jobId: string; authorId: string; content: string }): Promise<string> {
    const rowId = this.ids.newId();
    const write: WriteOperation = {
      kind: "write",
      id: this.ids.newId(),
      rowId,
      aggregate: "job_note",
      op: "insert",
      table: "job_notes",
      payload: {
        job_id: input.jobId,
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
