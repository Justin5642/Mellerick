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
  it("saves the text first with NO dependency, then uploads and attaches the audio", async () => {
    const { outbox, ops } = captureOutbox();
    const repo = new VoiceReportRepository(outbox, seqIds(), fixedTime());
    const { storagePath } = await repo.record({
      jobId: "j1",
      recordedBy: "u1",
      transcript: "Replaced the TMV.",
      localUri: "file:///doc/outbox/v.wav",
      audioExt: "wav",
    });

    // Stable per-job key so a re-record overwrites rather than orphaning the object.
    expect(storagePath).toBe("j1/voice-report.wav");
    expect(ops).toHaveLength(3);

    // The words must reach the office even if the recording never uploads.
    const saveText = ops[0] as SideEffectOperation;
    expect(saveText.kind).toBe("side_effect");
    expect(saveText.effect).toBe("transcribe-voice-report");
    expect(saveText.payload).toEqual({ jobId: "j1", transcript: "Replaced the TMV." });
    expect(saveText.dependsOn).toBeUndefined();
    expect(saveText.coalesceKey).toBe("voice-report-text:j1");

    const upload = ops[1] as WriteOperation;
    expect(upload.kind).toBe("write");
    expect(upload.op).toBe("upload"); // no metadata row is written by the client
    expect(upload.attachmentLocalPath).toBe("file:///doc/outbox/v.wav");
    expect(upload.payload).toEqual({ bucket: "job-audio", storage_path: "j1/voice-report.wav" });

    const attach = ops[2] as SideEffectOperation;
    expect(attach.payload).toEqual({ jobId: "j1", storagePath: "j1/voice-report.wav" });
    expect(attach.dependsOn).toBe(upload.id); // never point the job at a missing object
    expect(attach.coalesceKey).toBe("voice-report-audio:j1");
    expect(attach.coalesceKey).not.toBe(saveText.coalesceKey); // must not coalesce away the text
  });

  it("saves text only when the phone kept no recording", async () => {
    const { outbox, ops } = captureOutbox();
    const repo = new VoiceReportRepository(outbox, seqIds(), fixedTime());
    const { storagePath } = await repo.record({ jobId: "j1", recordedBy: "u1", transcript: "Done.", localUri: null });

    expect(storagePath).toBeNull();
    expect(ops).toHaveLength(1);
    expect((ops[0] as SideEffectOperation).payload).toEqual({ jobId: "j1", transcript: "Done." });
  });
});
