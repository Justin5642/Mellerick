// Shrink a photo in the browser before it is uploaded.
//
// The web Photos tab uploaded phone originals as-is (3–8 MB each) and then
// showed those same originals as grid thumbnails, so a job's Photos tab
// downloaded tens of megabytes. The mobile app has always resized first
// (mobile/lib/imageUpload.ts — 1600px long edge, JPEG 0.7); this matches it so
// a photo costs the same whichever app took it.
//
// Anything the browser cannot decode (HEIC on most desktop browsers, a corrupt
// file) is uploaded unchanged rather than refused — a big photo is better than
// a missing one.

export const MAX_EDGE_PX = 1600;
export const JPEG_QUALITY = 0.7;

/** Target size for an image so its longer edge is at most `max`. Never upscales. */
export function fitWithin(width: number, height: number, max = MAX_EDGE_PX): { width: number; height: number } {
  const longest = Math.max(width, height);
  if (longest <= max) return { width, height };
  const scale = max / longest;
  return { width: Math.round(width * scale), height: Math.round(height * scale) };
}

/** A JPEG no larger than MAX_EDGE_PX on its long edge, or the original file. */
export async function resizeImageForUpload(file: File): Promise<File> {
  if (!file.type.startsWith("image/") || typeof createImageBitmap !== "function") return file;
  let bitmap: ImageBitmap;
  try {
    // from-image: respect EXIF rotation, so portrait phone photos stay upright.
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    return file;
  }
  try {
    const { width, height } = fitWithin(bitmap.width, bitmap.height);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return file;
    ctx.drawImage(bitmap, 0, 0, width, height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", JPEG_QUALITY));
    // Keep the original if re-encoding somehow made it bigger (a tiny PNG).
    if (!blob || blob.size >= file.size) return file;
    const name = file.name.replace(/\.[^.]+$/, "") + ".jpg";
    return new File([blob], name, { type: "image/jpeg", lastModified: file.lastModified });
  } finally {
    bitmap.close();
  }
}
