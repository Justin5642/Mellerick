// Where a job photo's grid thumbnail lives in the job-photos bucket.
//
// `<jobId>/<file>` → `<jobId>/thumbs/<file>`. Same first path segment, so the
// job-scoped storage policies (0047/0049, split_part(name, '/', 1)) treat the
// thumbnail exactly like its photo. Thumbnails are ~400px JPEGs made by
// scripts/generate-photo-thumbnails.mjs; a photo without one simply falls back
// to its original. Nothing reads a thumbnail as the photo itself — the
// full-size viewer always loads the original.
//
// Kept identical in lib/photo-thumbs.ts (web) and mobile/lib/photoThumbs.ts.

export const THUMB_DIR = "thumbs";

export function thumbPathFor(storagePath: string): string {
  const slash = storagePath.indexOf("/");
  if (slash <= 0) return `${THUMB_DIR}/${storagePath}`;
  return `${storagePath.slice(0, slash)}/${THUMB_DIR}/${storagePath.slice(slash + 1)}`;
}
