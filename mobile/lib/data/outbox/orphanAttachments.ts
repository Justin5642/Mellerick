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

/**
 * The part of a staged attachment's path that survives an app update.
 *
 * iOS can move the app's data container when the app is updated (Apple: never
 * store absolute paths). Queued operations hold the full path they were given
 * at the time, so after a TestFlight update that path pointed at nothing: the
 * upload retried as a "network" failure for ever, and the sweep below — which
 * compared full paths — saw the real file as unreferenced and deleted it an
 * hour later (15 Nov 2026). Everything that identifies a staged file now goes
 * by this key: the path from "outbox-attachments/" on.
 */
export const ATTACHMENT_DIR_NAME = "outbox-attachments/";

export function attachmentKey(uri: string): string {
  const i = uri.lastIndexOf(ATTACHMENT_DIR_NAME);
  return i >= 0 ? uri.slice(i + ATTACHMENT_DIR_NAME.length) : uri;
}

/** Rebase a stored attachment path onto today's staging directory. Other paths are returned as given. */
export function resolveAttachmentUri(stored: string, currentDir: string): string {
  return stored.includes(ATTACHMENT_DIR_NAME) ? `${currentDir}${attachmentKey(stored)}` : stored;
}

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
  const referenced = new Set([...referencedUris].map(attachmentKey));
  return staged
    .filter((f) => !referenced.has(attachmentKey(f.uri)))
    .filter((f) => now - f.modifiedAt > graceMs)
    .map((f) => f.uri);
}
