import type { Outbox } from "../outbox/outbox";
import type { IdGen } from "../ids";
import type { WriteOperation, SideEffectOperation } from "../outbox/types";
import { systemTime, type TimeSource } from "../time";

const AUDIO_BUCKET = "job-audio";

export interface VoiceReportInput {
  jobId: string;
  recordedBy: string;
  /** A durable local m4a file (the recording). */
  localUri: string;
}

// Offline-first voice report: the recording uploads durably to the private
// job-audio bucket, then a transcribe side-effect calls the server route (which
// writes jobs.voice_report_* under service-role). The upload has NO metadata row
// of its own (op: "upload"), and the transcribe depends on it so the route never
// runs before its object exists. Coalesced per job — the latest recording wins,
// which matches the route's last-write-wins overwrite of the transcript.
export class VoiceReportRepository {
  constructor(
    private outbox: Outbox,
    private ids: IdGen,
    private time: TimeSource = systemTime
  ) {}

  async record(input: VoiceReportInput): Promise<{ storagePath: string }> {
    const uploadRowId = this.ids.newId();
    const storagePath = `${input.jobId}/voice-report-${uploadRowId}.m4a`;

    // 1) upload the audio (upload-only — no client-written row).
    const uploadOpId = this.ids.newId();
    const uploadOp: WriteOperation = {
      kind: "write",
      id: uploadOpId,
      rowId: uploadRowId, // unused for an upload-only op, but kept unique
      aggregate: "job",
      op: "upload",
      table: "", // unused for an upload-only op
      attachmentLocalPath: input.localUri,
      payload: { bucket: AUDIO_BUCKET, storage_path: storagePath },
      status: "pending",
      attempts: 0,
      nextAttemptAt: 0,
      createdAt: this.time.nowMs(),
    };
    await this.outbox.enqueue(uploadOp);

    // 2) transcribe once the object exists (online-only route; degrades to a
    //    queued retry when offline). storagePath is `${jobId}/...` so it passes
    //    the route's path-prefix guard.
    const transcribeOp: SideEffectOperation = {
      kind: "side_effect",
      id: this.ids.newId(),
      effect: "transcribe-voice-report",
      coalesceKey: `transcribe-voice-report:${input.jobId}`,
      payload: { jobId: input.jobId, storagePath, recordedBy: input.recordedBy },
      dependsOn: uploadOpId,
      status: "pending",
      attempts: 0,
      nextAttemptAt: 0,
      createdAt: this.time.nowMs(),
    };
    await this.outbox.enqueue(transcribeOp);

    return { storagePath };
  }
}
