import type { Outbox } from "../outbox/outbox";
import type { IdGen } from "../ids";
import type { WriteOperation, SideEffectOperation } from "../outbox/types";
import { systemTime, type TimeSource } from "../time";

const AUDIO_BUCKET = "job-audio";

export interface VoiceReportInput {
  jobId: string;
  recordedBy: string;
  /** What the technician said, recognised on the phone (lib/dictation.ts). */
  transcript: string;
  /**
   * A durable local copy of the recording, when the phone kept one (iOS and
   * Android 13+). Null on older Android: the report is saved as text only.
   */
  localUri: string | null;
  /** Extension of the recording ("wav", "caf", "m4a"). */
  audioExt?: string;
}

// Offline-first voice report, in up to three queued steps:
//
//   1. SAVE THE TEXT — no dependency, so the transcript reaches the office even
//      if the audio never uploads (a bucket that rejects the file type, a
//      dead-lettered upload). Losing the words because the recording failed
//      would be the worst outcome; the words are what the office reads.
//   2. UPLOAD the recording, when the phone kept one (upload-only — no
//      client-written row).
//   3. ATTACH THE AUDIO — sets the job's recording path, and depends on (2) so
//      the job never points at an object that is not there yet.
//
// The transcript is made on the phone (lib/dictation.ts); the server route only
// saves (/api/jobs/[id]/transcribe-voice-report — the path keeps its old name
// because operations already queued on phones call it). Steps 1 and 3 coalesce
// per job under separate keys, so the latest report wins for each.
export class VoiceReportRepository {
  constructor(
    private outbox: Outbox,
    private ids: IdGen,
    private time: TimeSource = systemTime
  ) {}

  async record(input: VoiceReportInput): Promise<{ storagePath: string | null }> {
    const saveText: SideEffectOperation = {
      kind: "side_effect",
      id: this.ids.newId(),
      effect: "transcribe-voice-report",
      coalesceKey: `voice-report-text:${input.jobId}`,
      payload: { jobId: input.jobId, transcript: input.transcript },
      status: "pending",
      attempts: 0,
      nextAttemptAt: 0,
      createdAt: this.time.nowMs(),
    };
    await this.outbox.enqueue(saveText);

    if (!input.localUri) return { storagePath: null };

    // Stable per-job object key: a re-record upserts over the same object
    // instead of orphaning the prior one in the private bucket.
    const storagePath = `${input.jobId}/voice-report.${input.audioExt ?? "m4a"}`;
    const uploadOp: WriteOperation = {
      kind: "write",
      id: this.ids.newId(),
      rowId: this.ids.newId(), // unused for an upload-only op, but kept unique
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

    const attachAudio: SideEffectOperation = {
      kind: "side_effect",
      id: this.ids.newId(),
      effect: "transcribe-voice-report",
      coalesceKey: `voice-report-audio:${input.jobId}`,
      payload: { jobId: input.jobId, storagePath },
      dependsOn: uploadOp.id,
      status: "pending",
      attempts: 0,
      nextAttemptAt: 0,
      createdAt: this.time.nowMs(),
    };
    await this.outbox.enqueue(attachAudio);

    return { storagePath };
  }
}
