// Reclaiming staged attachment files that nothing will ever upload.
//
// Attachments are copied into a durable staging directory before the operation
// that references them is enqueued (see attachments.ts). Two leaks follow:
//
//  1. persistOutboxAttachment() writes the file and returns; the CALLER then
//     enqueues the operation. A crash, force-quit or OS kill in between leaves a
//     file nothing points at, with no path to reclaim it.
//  2. A 'dead' operation keeps its file deliberately — retryDead() needs it —
//     but dead operations are never removed, so a permanently-failing photo
//     holds megabytes indefinitely.
//
// These are job photos and signature PNGs on a technician's work phone, so this
// is real storage accumulating over months in the field.

export interface StagedFile {
  uri: string;
  /** Epoch ms from the filesystem. */
  modifiedAt: number;
}

/**
 * How long a staged file is left alone before it can be considered an orphan.
 *
 * This exists for one specific race: persistOutboxAttachment() writes the file
 * and the caller enqueues the operation immediately afterwards. A sweep landing
 * in that gap would see a file with no referencing operation and delete a
 * technician's photo out from under the write about to claim it.
 *
 * The real gap is milliseconds. An hour is absurdly generous on purpose —
 * deleting a live attachment is unrecoverable, while keeping a dead one costs
 * only disk until the next sweep.
 */
export const ORPHAN_GRACE_MS = 60 * 60 * 1000;

/**
 * Staged files safe to delete: referenced by no operation, and old enough that
 * they cannot be mid-enqueue.
 *
 * Pure, so the decision is testable without a filesystem. Every uncertainty
 * resolves towards KEEPING the file — including a timestamp in the future,
 * which a forward clock jump can produce and which would otherwise make a
 * just-written file look ancient.
 */
export function selectOrphanAttachments(
  staged: StagedFile[],
  referencedUris: Set<string>,
  now: number,
  graceMs: number = ORPHAN_GRACE_MS
): string[] {
  return staged
    .filter((f) => !referencedUris.has(f.uri))
    .filter((f) => now - f.modifiedAt > graceMs)
    .map((f) => f.uri);
}
