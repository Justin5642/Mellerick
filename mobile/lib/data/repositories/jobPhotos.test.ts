import { JobPhotosRepository } from "./jobPhotos";
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
const writes = (ops: Operation[]) => ops.filter((o): o is WriteOperation => o.kind === "write");

describe("JobPhotosRepository", () => {
  it("add enqueues an attachment insert: object uploads before the row, bucket is transport-only", async () => {
    const { outbox, ops } = captureOutbox();
    const repo = new JobPhotosRepository(outbox, seqIds(), fixedTime());
    const { id, storagePath } = await repo.add({
      jobId: "j1",
      uploadedBy: "u1",
      photoType: "before",
      localUri: "file:///doc/outbox/abc.jpg",
    });

    // rowId = first id; storage key is derived from it → idempotent replay
    expect(id).toBe("id-1");
    expect(storagePath).toBe("j1/id-1.jpg");

    const [w] = writes(ops);
    expect(w.op).toBe("insert");
    expect(w.table).toBe("job_photos");
    expect(w.aggregate).toBe("job_photo");
    expect(w.rowId).toBe("id-1");
    expect(w.id).not.toBe(w.rowId); // op id distinct from row id
    expect(w.attachmentLocalPath).toBe("file:///doc/outbox/abc.jpg"); // upload-before-row trigger
    expect(w.payload).toEqual({
      bucket: "job-photos",
      storage_path: "j1/id-1.jpg",
      job_id: "j1",
      uploaded_by: "u1",
      photo_type: "before",
    });
    // no created_at sent — DB default owns ordering
    expect(w.payload).not.toHaveProperty("created_at");
  });

  it("add honours a non-default extension in the object key", async () => {
    const { outbox, ops } = captureOutbox();
    const repo = new JobPhotosRepository(outbox, seqIds(), fixedTime());
    const { storagePath } = await repo.add({ jobId: "j9", uploadedBy: "u1", photoType: "signature", localUri: "file:///s.png", ext: "png" });
    expect(storagePath).toBe("j9/id-1.png");
    expect(writes(ops)[0].payload.storage_path).toBe("j9/id-1.png");
  });

  it("remove enqueues a delete carrying storage_path + bucket for object cleanup, no attachment", async () => {
    const { outbox, ops } = captureOutbox();
    const repo = new JobPhotosRepository(outbox, seqIds(), fixedTime());
    await repo.remove({ id: "photo-7", storagePath: "j1/photo-7.jpg" });

    const [w] = writes(ops);
    expect(w.op).toBe("delete");
    expect(w.rowId).toBe("photo-7");
    expect(w.attachmentLocalPath).toBeUndefined();
    expect(w.payload).toEqual({ bucket: "job-photos", storage_path: "j1/photo-7.jpg" });
  });
});
