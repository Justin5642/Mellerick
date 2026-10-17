// Signed-URL cache shared across mounts of a page.
//
// Every time the Photos tab mounted it signed every photo again. A new
// signature is a new URL, so the browser's HTTP cache never matched and the
// same images were downloaded on every visit to the tab. Keeping the URL for
// most of its lifetime lets the browser reuse what it already has.

type Entry = { url: string; expiresAt: number };

const cache = new Map<string, Entry>();

/** Reuse a URL until this long before it expires, so it never dies mid-view. */
const SAFETY_MARGIN_MS = 5 * 60 * 1000;

function key(bucket: string, path: string) {
  return `${bucket}/${path}`;
}

export function getCachedSignedUrl(bucket: string, path: string, now = Date.now()): string | null {
  const entry = cache.get(key(bucket, path));
  if (!entry) return null;
  if (entry.expiresAt - SAFETY_MARGIN_MS <= now) {
    cache.delete(key(bucket, path));
    return null;
  }
  return entry.url;
}

export function putCachedSignedUrl(bucket: string, path: string, url: string, expiresInSeconds: number, now = Date.now()) {
  cache.set(key(bucket, path), { url, expiresAt: now + expiresInSeconds * 1000 });
}

export function clearSignedUrlCache() {
  cache.clear();
}
