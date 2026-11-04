import { SignatureRepository, dayFinishNote, technicianSignOffNote } from "./signature";
import type { Outbox } from "../outbox/outbox";
import type { IdGen } from "../ids";
import type { Operation, WriteOperation, SideEffectOperation } from "../outbox/types";
import type { TimeSource } from "../time";

function seqIds(): IdGen {
  let n = 0;
  return { newId: () => `id-${++n}` };
}
const fixedTime = (ms = 1_000, iso = "2026-07-22T10:00:00.000Z"): TimeSource => ({ nowMs: () => ms, nowIso: () => iso });

function captureOutbox(): { outbox: Outbox; ops: Operation[] } {
  const ops: Operation[] = [];
  const outbox = { enqueue: jest.fn(async (op: Operation) => void ops.push(op)) } as unknown as Outbox;
  return { outbox, ops };
}
const writes = (ops: Operation[]) => ops.filter((o): o is WriteOperation => o.kind === "write");
const sides = (ops: Operation[]) => ops.filter((o): o is SideEffectOperation => o.kind === "side_effect");

describe("SignatureRepository", () => {
  it("signOff enqueues the signature photo, the job-completed update, and a dependent sync-calendar", async () => {
    const { outbox, ops } = captureOutbox();
    const repo = new SignatureRepository(outbox, seqIds(), fixedTime());
    const { photoId, storagePath } = await repo.signOff({
      jobId: "j1",
      uploadedBy: "u1",
      signerName: "John Smith",
      localUri: "file:///doc/outbox/sig.png",
      signedOffDate: "22/07/2026",
    });

    expect(photoId).toBe("id-1");
    expect(storagePath).toBe("j1/signature_id-1.png");

    const [photo, jobUpdate] = writes(ops);
    // 1) signature image
    expect(photo).toMatchObject({ op: "insert", table: "job_photos", rowId: "id-1", attachmentLocalPath: "file:///doc/outbox/sig.png" });
    // completion is GATED on the signature image landing (no invoice-ready job
    // without proof of sign-off).
    expect(jobUpdate.dependsOn).toBe(photo.id);
    expect(photo.payload).toEqual({
      bucket: "job-photos",
      storage_path: "j1/signature_id-1.png",
      job_id: "j1",
      uploaded_by: "u1",
      photo_type: "signature",
      caption: "John Smith",
    });
    // 2) job completion
    expect(jobUpdate).toMatchObject({ op: "update", table: "jobs", rowId: "j1", aggregate: "job" });
    expect(jobUpdate.payload).toEqual({
      completion_notes: "Signed off by: John Smith on 22/07/2026",
      status: "completed",
      actual_end: "2026-07-22T10:00:00.000Z",
      ready_to_invoice: true,
    });
    // 3) calendar resync depends on the job update
    const [cal] = sides(ops);
    expect(cal.effect).toBe("sync-calendar");
    expect(cal.coalesceKey).toBe("sync-calendar:j1");
    expect(cal.payload).toEqual({ jobId: "j1" });
    expect(cal.dependsOn).toBe(jobUpdate.id);
  });

  it("falls back to 'Customer' labels when no signer name is given", async () => {
    const { outbox, ops } = captureOutbox();
    const repo = new SignatureRepository(outbox, seqIds(), fixedTime());
    await repo.signOff({ jobId: "j1", uploadedBy: "u1", signerName: "", localUri: "file:///s.png", signedOffDate: "22/07/2026" });
    const [photo, jobUpdate] = writes(ops);
    expect(photo.payload.caption).toBe("Customer signature");
    expect(jobUpdate.payload.completion_notes).toBe("Signed off by: Customer on 22/07/2026");
  });

  it("completeAsTechnician completes the job with no signature to wait for, then resyncs the calendar", async () => {
    const { outbox, ops } = captureOutbox();
    const repo = new SignatureRepository(outbox, seqIds(), fixedTime());
    await repo.completeAsTechnician({ jobId: "j1", technicianName: "Brodie Unwin", signedOffDate: "03/11/2026" });
    const [jobUpdate] = writes(ops);
    expect(writes(ops)).toHaveLength(1);
    expect(jobUpdate.table).toBe("jobs");
    expect(jobUpdate.dependsOn).toBeUndefined();
    expect(jobUpdate.payload).toMatchObject({
      status: "completed",
      ready_to_invoice: true,
      completion_notes: "Signed off by technician Brodie Unwin on 03/11/2026 (customer not on site)",
    });
    const cal = ops.find((o) => o.kind === "side_effect")!;
    expect(cal.dependsOn).toBe(jobUpdate.id);
  });

  it("names 'the technician' when the name isn't known", () => {
    expect(technicianSignOffNote(null, "03/11/2026")).toBe("Signed off by the technician on 03/11/2026 (customer not on site)");
  });

  it("finishForToday leaves a dated day note and one stage-complete call per stage, and completes nothing", async () => {
    const { outbox, ops } = captureOutbox();
    const repo = new SignatureRepository(outbox, seqIds(), fixedTime());
    await repo.finishForToday({
      jobId: "j1",
      authorId: "u1",
      date: "04/11/2026",
      note: "Sewer laid to boundary",
      stages: [{ id: "s1", name: "Sewer" }],
    });
    const [note] = writes(ops);
    expect(writes(ops)).toHaveLength(1);
    expect(note.table).toBe("job_notes");
    expect(note.payload).toEqual({
      job_id: "j1",
      author_id: "u1",
      source: "day_finish",
      content: "Finished for today (04/11/2026): Sewer laid to boundary\nStage complete: Sewer",
    });
    const stage = ops.find((o) => o.kind === "side_effect")!;
    expect(stage).toMatchObject({ effect: "stage-complete", coalesceKey: "stage-complete:s1" });
    expect(stage.payload).toEqual({ jobId: "j1", stageId: "s1", completedAt: "2026-07-22T10:00:00.000Z" });
    expect(ops.some((o) => o.kind === "write" && o.table === "jobs")).toBe(false);
  });

  it("dayFinishNote works with no note and no stages", () => {
    expect(dayFinishNote({ date: "04/11/2026", note: " ", stagesCompleted: [] })).toBe("Finished for today (04/11/2026)");
  });
});

