import type { Outbox } from "../outbox/outbox";
import type { IdGen } from "../ids";
import type { WriteOperation } from "../outbox/types";
import { systemTime, type TimeSource } from "../time";

// job_photos.photo_type is CHECK-constrained to exactly these values.
export type PhotoType = "before" | "after" | "general" | "signature";

const BUCKET = "job-photos";

export interface AddPhotoInput {
  jobId: string;
  uploadedBy: string;
  photoType: PhotoType;
  /** A durable local file (already copied out of the volatile picker/cache dir). */
  localUri: string;
  /** File extension for the Storage object key; photos are always jpg. */
  ext?: string;
}

// Offline-first write path for job photos. An add enqueues a single durable
// operation carrying the local file: the processor uploads the object to Storage
// FIRST, then writes the metadata row, so a row never references a missing
// object. The row PK is a client UUID, and the Storage object key is derived
// from it (`${jobId}/${rowId}.jpg`) so a replay re-uploads to the same key
// (upsert) and re-inserts the same row — fully idempotent, no duplicates.
export class JobPhotosRepository {
  constructor(
    private outbox: Outbox,
    private ids: IdGen,
    private time: TimeSource = systemTime
  ) {}

  /** Queue a photo. Returns the new row id and the Storage object key so the
   * screen can show the local file optimistically under that key. */
  async add(input: AddPhotoInput): Promise<{ id: string; storagePath: string }> {
    const rowId = this.ids.newId();
    const storagePath = `${input.jobId}/${rowId}.${input.ext ?? "jpg"}`;
    const write: WriteOperation = {
      kind: "write",
      id: this.ids.newId(),
      rowId,
      aggregate: "job_photo",
      op: "insert",
      table: "job_photos",
      attachmentLocalPath: input.localUri, // triggers upload-before-row in the processor
      payload: {
        bucket: BUCKET, // transport-only; stripped before the row write
        storage_path: storagePath, // real column AND the Storage object key
        job_id: input.jobId,
        uploaded_by: input.uploadedBy,
        photo_type: input.photoType,
      },
      status: "pending",
      attempts: 0,
      nextAttemptAt: 0,
      createdAt: this.time.nowMs(),
    };
    await this.outbox.enqueue(write);
    return { id: rowId, storagePath };
  }

  /** Queue a photo delete. The processor removes the Storage object (best-effort)
   * then deletes the row — carrying storage_path so object cleanup can happen
   * once the bucket has a DELETE policy (see DECISIONS D12). */
  async remove(input: { id: string; storagePath: string }): Promise<void> {
    const write: WriteOperation = {
      kind: "write",
      id: this.ids.newId(),
      rowId: input.id,
      aggregate: "job_photo",
      op: "delete",
      table: "job_photos",
      payload: { bucket: BUCKET, storage_path: input.storagePath },
      status: "pending",
      attempts: 0,
      nextAttemptAt: 0,
      createdAt: this.time.nowMs(),
    };
    await this.outbox.enqueue(write);
  }
}
