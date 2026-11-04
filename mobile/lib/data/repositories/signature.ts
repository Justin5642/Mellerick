import type { Outbox } from "../outbox/outbox";
import type { IdGen } from "../ids";
import type { WriteOperation, SideEffectOperation } from "../outbox/types";
import { systemTime, type TimeSource } from "../time";

const BUCKET = "job-photos";

export interface SignOffInput {
  jobId: string;
  uploadedBy: string;
  signerName: string;
  /** A durable local PNG file (the signature image). */
  localUri: string;
  /** Localized date label for completion_notes (e.g. new Date().toLocaleDateString("en-AU")). */
  signedOffDate: string;
}

/**
 * The completion note for a job the technician signed off themselves because
 * the customer wasn't there (2 Nov 2026: "9 times out of 10, the customer is
 * not there when we finish the job").
 */
export function technicianSignOffNote(technicianName: string | null, signedOffDate: string): string {
  const who = technicianName?.trim() ? `technician ${technicianName.trim()}` : "the technician";
  return `Signed off by ${who} on ${signedOffDate} (customer not on site)`;
}

// Offline-first job completion via customer signature — a compound write mirroring
// the web/mobile handleOK: (1) the signature image as an attachment insert into
// job_photos, (2) a jobs UPDATE marking the job completed + ready to invoice,
// (3) a coalesced sync-calendar side-effect that runs after the jobs update. All
// durable so a sign-off in a no-signal basement completes and syncs on reconnect.
export class SignatureRepository {
  constructor(
    private outbox: Outbox,
    private ids: IdGen,
    private time: TimeSource = systemTime
  ) {}

  async signOff(input: SignOffInput): Promise<{ photoId: string; storagePath: string }> {
    const photoRowId = this.ids.newId();
    const storagePath = `${input.jobId}/signature_${photoRowId}.png`;
    const caption = input.signerName || "Customer signature";

    // 1) the signature image (upload-before-row into job_photos).
    const photoOpId = this.ids.newId();
    const photoOp: WriteOperation = {
      kind: "write",
      id: photoOpId,
      rowId: photoRowId,
      aggregate: "job_photo",
      op: "insert",
      table: "job_photos",
      attachmentLocalPath: input.localUri,
      payload: {
        bucket: BUCKET,
        storage_path: storagePath,
        job_id: input.jobId,
        uploaded_by: input.uploadedBy,
        photo_type: "signature",
        caption,
      },
      status: "pending",
      attempts: 0,
      nextAttemptAt: 0,
      createdAt: this.time.nowMs(),
    };
    await this.outbox.enqueue(photoOp);

    // 2) mark the job completed — GATED on the signature image landing first
    //    (dependsOn photoOp). This preserves the web invariant: the old handleOK
    //    aborted before completing the job if the signature upload failed, so a
    //    job is never marked completed + ready_to_invoice without its signature
    //    on file. Failure now leaves the job incomplete (safe) rather than
    //    invoice-ready-without-proof.
    const jobsOpId = this.ids.newId();
    const jobsOp: WriteOperation = {
      kind: "write",
      id: jobsOpId,
      rowId: input.jobId,
      aggregate: "job",
      op: "update",
      table: "jobs",
      dependsOn: photoOpId,
      payload: {
        completion_notes: `Signed off by: ${input.signerName || "Customer"} on ${input.signedOffDate}`,
        status: "completed",
        actual_end: this.time.nowIso(),
        ready_to_invoice: true,
      },
      status: "pending",
      attempts: 0,
      nextAttemptAt: 0,
      createdAt: this.time.nowMs(),
    };
    await this.outbox.enqueue(jobsOp);

    // 3) resync the calendar once the job is marked completed.
    const calOp: SideEffectOperation = {
      kind: "side_effect",
      id: this.ids.newId(),
      effect: "sync-calendar",
      coalesceKey: `sync-calendar:${input.jobId}`,
      payload: { jobId: input.jobId },
      dependsOn: jobsOpId,
      status: "pending",
      attempts: 0,
      nextAttemptAt: 0,
      createdAt: this.time.nowMs(),
    };
    await this.outbox.enqueue(calOp);

    return { photoId: photoRowId, storagePath };
  }

  /**
   * The customer isn't there: the technician completes the job themselves. The
   * same job update and calendar resync as signOff, with no signature image to
   * wait for.
   */
  async completeAsTechnician(input: { jobId: string; technicianName: string | null; signedOffDate: string }): Promise<void> {
    const jobsOpId = this.ids.newId();
    await this.outbox.enqueue({
      kind: "write",
      id: jobsOpId,
      rowId: input.jobId,
      aggregate: "job",
      op: "update",
      table: "jobs",
      payload: {
        completion_notes: technicianSignOffNote(input.technicianName, input.signedOffDate),
        status: "completed",
        actual_end: this.time.nowIso(),
        ready_to_invoice: true,
      },
      status: "pending",
      attempts: 0,
      nextAttemptAt: 0,
      createdAt: this.time.nowMs(),
    });
    await this.outbox.enqueue({
      kind: "side_effect",
      id: this.ids.newId(),
      effect: "sync-calendar",
      coalesceKey: `sync-calendar:${input.jobId}`,
      payload: { jobId: input.jobId },
      dependsOn: jobsOpId,
      status: "pending",
      attempts: 0,
      nextAttemptAt: 0,
      createdAt: this.time.nowMs(),
    });
  }
}
