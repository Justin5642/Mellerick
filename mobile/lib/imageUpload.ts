import { ImageManipulator, SaveFormat } from "expo-image-manipulator";

// ONE place every picked or captured image passes through before it is queued
// for upload (job photos, variation photos, expense receipts, fleet receipts)
// or sent for a data-plate scan.
//
// WHY: the pickers were returning full-resolution originals (12–50 MP) at
// quality 0.6–0.7 — roughly 2–4 MB each. That cost the technician's mobile data
// on upload and again on every view, since the photo grid showed the original.
// 1600px on the longest edge is plenty for site evidence and for a receipt to be
// legible, and Claude's vision read of a data plate works at that size; at JPEG
// 0.7 it lands around 200–400 KB.
//
// ORIENTATION: the manipulator decodes through the platform image loader, which
// applies the EXIF orientation tag, so the pixels it renders are already upright.
// The longest edge is measured on THAT rendered image (not on the picker's
// reported width/height, which on some Android builds are pre-rotation), and the
// re-encoded JPEG carries no orientation tag that could rotate it twice.
//
// OFFLINE: purely local — reads and writes files in the app cache. The caller
// still copies the result into the durable outbox staging dir
// (persistOutboxAttachment), exactly as it did with the picker's file.

export const MAX_EDGE_PX = 1600;
export const JPEG_QUALITY = 0.7;

export interface PreparedImage {
  uri: string;
  width: number;
  height: number;
  /** Present only when requested (the data-plate scan posts it as JSON). */
  base64?: string;
}

/**
 * Downscale so the longest edge is at most MAX_EDGE_PX (never upscales) and
 * re-encode as JPEG at JPEG_QUALITY. Throws if the image cannot be decoded.
 */
export async function prepareImage(sourceUri: string, opts: { base64?: boolean } = {}): Promise<PreparedImage> {
  const ctx = ImageManipulator.manipulate(sourceUri);
  let ref = await ctx.renderAsync();
  const longest = Math.max(ref.width, ref.height);
  if (longest > MAX_EDGE_PX) {
    ctx.resize(ref.width >= ref.height ? { width: MAX_EDGE_PX } : { height: MAX_EDGE_PX });
    ref = await ctx.renderAsync();
  }
  const saved = await ref.saveAsync({
    format: SaveFormat.JPEG,
    compress: JPEG_QUALITY,
    base64: !!opts.base64,
  });
  return {
    uri: saved.uri,
    width: saved.width,
    height: saved.height,
    ...(saved.base64 !== undefined ? { base64: saved.base64 } : {}),
  };
}

/**
 * The upload path: prepareImage, but a photo is NEVER lost to a resize failure.
 * If the image cannot be re-encoded (an exotic format, a decoder fault) the
 * original file is queued instead — a larger upload is a cost, a technician's
 * evidence silently vanishing is a defect.
 */
export async function prepareImageForUpload(sourceUri: string): Promise<string> {
  try {
    return (await prepareImage(sourceUri)).uri;
  } catch (e) {
    if (__DEV__) console.warn("[imageUpload] resize failed, queueing the original:", e);
    return sourceUri;
  }
}
