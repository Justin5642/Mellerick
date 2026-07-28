import { useCallback, useEffect, useState } from "react";
import { useDataLayer } from "./DataProvider";

export interface SyncStatus {
  /** Operations still outstanding and being retried (pending + failed + inflight). */
  pending: number;
  /** Operations that gave up retrying (terminal) — needs user attention. */
  failed: number;
  /** True while nothing is outstanding and nothing is dead. */
  synced: boolean;
  /** Re-queue every terminally-failed op and kick a drain (the badge's Retry). */
  retry: () => void;
}

// Polls the outbox so a badge can show pending/failed sync state and offer a
// retry. Cheap COUNT queries; the interval is coarse because this only drives a
// status pill.
export function useSyncStatus(pollMs = 3000): SyncStatus {
  const layer = useDataLayer();
  const [counts, setCounts] = useState<{ pending: number; failed: number }>({ pending: 0, failed: 0 });

  useEffect(() => {
    if (!layer) return;
    let active = true;
    const tick = async () => {
      // Re-check after every await: a tick that began before teardown must not
      // keep querying SQLite afterwards. On a dev reload the native handles are
      // gone with the JS context, and touching one throws "Cannot use shared
      // object that was already released" — as an UNHANDLED rejection out of an
      // interval, which React Native puts on screen as a red error box.
      if (!active) return;
      try {
        const [pending, dead] = await Promise.all([layer.outbox.pendingCount(), layer.outbox.deadCount()]);
        if (active) setCounts({ pending, failed: dead });
      } catch (e) {
        // A status badge is not worth an error screen; the next tick recovers.
        if (__DEV__) console.warn("[sync] status poll failed:", e);
      }
    };
    void tick();
    const iv = setInterval(tick, pollMs);
    return () => {
      active = false;
      clearInterval(iv);
    };
  }, [layer, pollMs]);

  const retry = useCallback(() => {
    if (!layer) return;
    void (async () => {
      try {
        await layer.outbox.retryDead();
        await layer.engine.flush();
      } catch (e) {
        if (__DEV__) console.warn("[sync] retry failed:", e);
      }
    })();
  }, [layer]);

  return { pending: counts.pending, failed: counts.failed, synced: counts.pending === 0 && counts.failed === 0, retry };
}
