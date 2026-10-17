import { Image } from "expo-image";

/**
 * Empty expo-image's memory and disk caches. Called at sign-out.
 *
 * The Photos tab caches every job photo, receipt and signature on disk, keyed
 * by storage path, so revisits skip the network (HANDOVER §3, Photos). That
 * cache is not scoped to a user: after a sign-out, the next person on the phone
 * — or anyone holding a lost one — could still be shown the previous person's
 * job photos without a single authorised request.
 *
 * Best-effort, never throws: a cache that fails to clear must not stop a
 * sign-out.
 */
export async function clearImageCaches(): Promise<void> {
  try {
    await Promise.all([Image.clearMemoryCache(), Image.clearDiskCache()]);
  } catch (e) {
    console.warn("[imageCache] could not clear at sign-out:", e instanceof Error ? e.message : String(e));
  }
}
