import { JobStageNotesRepository } from "./jobStageNotes";
import type { Outbox } from "../outbox/outbox";
import type { IdGen } from "../ids";
import type { Operation, WriteOperation } from "../outbox/types";
import type { TimeSource } from "../time";

function seqIds(): IdGen {
  let n = 0;
  return { newId: () => `id-${++n}` };
}
const fixedTime = (ms = 1_000): TimeSource => ({ nowMs: () => ms, nowIso: () => "2026-07-22T00:00:00.000Z" });

function captureOutbox(): { outbox: Outbox; ops: Operation[] } {
  const ops: Operation[] = [];
  const outbox = { enqueue: jest.fn(async (op: Operation) => void ops.push(op)) } as unknown as Outbox;
  return { outbox, ops };
}

describe("JobStageNotesRepository", () => {
  it("add enqueues a single plain insert (no attachment, no side-effect) and returns the row id", async () => {
    const { outbox, ops } = captureOutbox();
    const repo = new JobStageNotesRepository(outbox, seqIds(), fixedTime());
    const id = await repo.add({ jobId: "j1", stage: "drain", authorId: "u1", content: "Drain run clear, no root intrusion." });

    expect(id).toBe("id-1");
    expect(ops).toHaveLength(1); // exactly one op: no billing/side-effect
    const w = ops[0] as WriteOperation;
    expect(w.kind).toBe("write");
    expect(w.op).toBe("insert");
    expect(w.table).toBe("job_stage_notes");
    expect(w.aggregate).toBe("job_stage_note");
    expect(w.rowId).toBe("id-1");
    expect(w.attachmentLocalPath).toBeUndefined();
    expect(w.dependsOn ?? null).toBeNull();
    expect(w.payload).toEqual({ job_id: "j1", stage: "drain", author_id: "u1", content: "Drain run clear, no root intrusion." });
    expect(w.payload).not.toHaveProperty("created_at"); // DB default owns ordering
  });

  it("update enqueues a content-only update keyed by the note's own id", async () => {
    const { outbox, ops } = captureOutbox();
    const repo = new JobStageNotesRepository(outbox, seqIds(), fixedTime());
    await repo.update({ id: "note-1", content: "Fixed typo" });

    expect(ops).toHaveLength(1);
    const w = ops[0] as WriteOperation;
    expect(w.kind).toBe("write");
    expect(w.op).toBe("update");
    expect(w.table).toBe("job_stage_notes");
    expect(w.aggregate).toBe("job_stage_note");
    expect(w.rowId).toBe("note-1");
    expect(w.id).toBe("id-1"); // fresh op id; rowId is the note
    expect(w.attachmentLocalPath).toBeUndefined();
    // Only the text — never re-point the stage, author or job.
    expect(w.payload).toEqual({ content: "Fixed typo" });
  });

  it("remove enqueues a plain delete of the note's row (no storage object)", async () => {
    const { outbox, ops } = captureOutbox();
    const repo = new JobStageNotesRepository(outbox, seqIds(), fixedTime());
    await repo.remove({ id: "note-1" });

    expect(ops).toHaveLength(1);
    const w = ops[0] as WriteOperation;
    expect(w.kind).toBe("write");
    expect(w.op).toBe("delete");
    expect(w.table).toBe("job_stage_notes");
    expect(w.aggregate).toBe("job_stage_note");
    expect(w.rowId).toBe("note-1");
    expect(w.payload).toEqual({});
    expect(w.attachmentLocalPath).toBeUndefined();
    expect(w.attachmentPathField).toBeUndefined();
  });
});
