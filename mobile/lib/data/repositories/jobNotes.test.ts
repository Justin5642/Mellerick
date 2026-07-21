import { JobNotesRepository } from "./jobNotes";
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

describe("JobNotesRepository", () => {
  it("add enqueues a single plain insert (no attachment, no side-effect) and returns the row id", async () => {
    const { outbox, ops } = captureOutbox();
    const repo = new JobNotesRepository(outbox, seqIds(), fixedTime());
    const id = await repo.add({ jobId: "j1", authorId: "u1", content: "Tap fixed, tested OK." });

    expect(id).toBe("id-1");
    expect(ops).toHaveLength(1); // exactly one op: no billing/side-effect
    const w = ops[0] as WriteOperation;
    expect(w.kind).toBe("write");
    expect(w.op).toBe("insert");
    expect(w.table).toBe("job_notes");
    expect(w.aggregate).toBe("job_note");
    expect(w.rowId).toBe("id-1");
    expect(w.attachmentLocalPath).toBeUndefined();
    expect(w.dependsOn ?? null).toBeNull();
    expect(w.payload).toEqual({ job_id: "j1", author_id: "u1", content: "Tap fixed, tested OK." });
    expect(w.payload).not.toHaveProperty("created_at"); // DB default owns ordering
  });
});
