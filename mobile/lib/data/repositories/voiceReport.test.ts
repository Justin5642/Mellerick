import { VoiceReportRepository } from "./voiceReport";
import type { Outbox } from "../outbox/outbox";
import type { IdGen } from "../ids";
import type { Operation, WriteOperation, SideEffectOperation } from "../outbox/types";
import type { TimeSource } from "../time";

function seqIds(): IdGen {
  let n = 0;
  return { newId: () => `id-${++n}` };
}
const fixedTime = (ms = 1_000): TimeSource => ({ nowMs: () => ms, nowIso: () => "2026-07-22T10:00:00.000Z" });

function captureOutbox(): { outbox: Outbox; ops: Operation[] } {
  const ops: Operation[] = [];
  const outbox = { enqueue: jest.fn(async (op: Operation) => void ops.push(op)) } as unknown as Outbox;
  return { outbox, ops };
}

describe("VoiceReportRepository", () => {
  it("record enqueues an upload-only op then a transcribe side-effect that depends on it", async () => {
    const { outbox, ops } = captureOutbox();
    const repo = new VoiceReportRepository(outbox, seqIds(), fixedTime());
    const { storagePath } = await repo.record({ jobId: "j1", recordedBy: "u1", localUri: "file:///doc/outbox/v.m4a" });

    // Stable per-job key so a re-record overwrites rather than orphaning the object.
    expect(storagePath).toBe("j1/voice-report.m4a");

    const upload = ops[0] as WriteOperation;
    expect(upload.kind).toBe("write");
    expect(upload.op).toBe("upload"); // no metadata row is written by the client
    expect(upload.attachmentLocalPath).toBe("file:///doc/outbox/v.m4a");
    expect(upload.payload).toEqual({ bucket: "job-audio", storage_path: "j1/voice-report.m4a" });

    const transcribe = ops[1] as SideEffectOperation;
    expect(transcribe.kind).toBe("side_effect");
    expect(transcribe.effect).toBe("transcribe-voice-report");
    expect(transcribe.coalesceKey).toBe("transcribe-voice-report:j1");
    expect(transcribe.payload).toEqual({ jobId: "j1", storagePath: "j1/voice-report.m4a", recordedBy: "u1" });
    expect(transcribe.dependsOn).toBe(upload.id); // never transcribe before the object exists
  });
});
