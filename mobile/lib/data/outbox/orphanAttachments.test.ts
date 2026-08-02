import { selectOrphanAttachments, ORPHAN_GRACE_MS, type StagedFile } from "./orphanAttachments";

// Staged attachment files leak in two ways, and neither is recoverable today:
//
//  1. persistOutboxAttachment() writes the file, and the CALLER then enqueues the
//     operation that references it. A crash, force-quit or OS kill between those
//     two steps leaves a file nothing points at, forever.
//  2. A 'dead' operation keeps its file deliberately (retryDead needs it), but a
//     dead op is never removed, so a permanently-failing photo holds several
//     megabytes on a technician's phone indefinitely.
//
// These are job photos and signature PNGs on a work phone, so the cost is real
// storage over months in the field.

const file = (uri: string, modifiedAt: number): StagedFile => ({ uri, modifiedAt });

describe("selectOrphanAttachments", () => {
  const NOW = 10_000_000;
  const OLD = NOW - ORPHAN_GRACE_MS - 1;

  it("selects a staged file that no operation references", () => {
    const orphans = selectOrphanAttachments([file("a.jpg", OLD)], new Set(), NOW);
    expect(orphans).toEqual(["a.jpg"]);
  });

  it("keeps a file that a queued operation still references", () => {
    const orphans = selectOrphanAttachments([file("a.jpg", OLD)], new Set(["a.jpg"]), NOW);
    expect(orphans).toEqual([]);
  });

  // THE DANGEROUS CASE. persistOutboxAttachment writes the file and returns; the
  // caller enqueues immediately after. A sweep landing in that gap would see a
  // file with no referencing operation and delete the technician's photo out
  // from under the write that was about to claim it.
  it("NEVER deletes a file young enough to be mid-enqueue", () => {
    const justWritten = file("a.jpg", NOW - 1_000);
    expect(selectOrphanAttachments([justWritten], new Set(), NOW)).toEqual([]);
  });

  it("treats a file exactly at the grace boundary as still in flight", () => {
    const boundary = file("a.jpg", NOW - ORPHAN_GRACE_MS);
    expect(selectOrphanAttachments([boundary], new Set(), NOW)).toEqual([]);
  });

  it("selects several orphans and leaves referenced and young files alone", () => {
    const orphans = selectOrphanAttachments(
      [
        file("orphan-1.jpg", OLD),
        file("referenced.jpg", OLD),
        file("orphan-2.png", OLD),
        file("just-written.jpg", NOW - 5),
      ],
      new Set(["referenced.jpg"]),
      NOW
    );
    expect(orphans.sort()).toEqual(["orphan-1.jpg", "orphan-2.png"]);
  });

  it("is a no-op when the staging directory is empty", () => {
    expect(selectOrphanAttachments([], new Set(["a.jpg"]), NOW)).toEqual([]);
  });

  // A device whose clock has jumped forward reports files as older than they are;
  // a backward jump makes them look like the future. Neither may delete a
  // referenced file — only the grace period is affected, and erring towards
  // keeping a file is always the safe direction.
  it("keeps a file whose timestamp is in the future (clock skew)", () => {
    expect(selectOrphanAttachments([file("a.jpg", NOW + 60_000)], new Set(), NOW)).toEqual([]);
  });
});
