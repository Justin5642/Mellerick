import { useCallback, useEffect, useState } from "react";
import { useDataLayer } from "./DataProvider";
import { reportSyncError } from "../monitoring";
import { nextPollDelay, type OutboxCounts } from "./syncStatusCadence";

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

// Drives the sync badge's pending/failed counts. Event-driven, with an adaptive
// poll as the safety net — see lib/data/syncStatusCadence.ts for the cadence
// (3s while work is outstanding, 30s idle heartbeat) and why.
export function useSyncStatus(): SyncStatus {
  const layer = useDataLayer();
  const [counts, setCounts] = useState<{ pending: number; failed: number }>({ pending: 0, failed: 0 });

  useEffect(() => {
    if (!layer) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let running = false;
    let again = false;

    const schedule = (last: OutboxCounts | null) => {
      if (!active) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void tick(), nextPollDelay(last));
    };

    const tick = async () => {
      // Re-check after every await: a tick that began before teardown must not
      // keep querying SQLite afterwards. On a dev reload the native handles are
      // gone with the JS context, and touching one throws "Cannot use shared
      // object that was already released" — as an UNHANDLED rejection out of a
      // timer, which React Native puts on screen as a red error box.
      if (!active) return;
      // Coalesce: an event landing mid-read re-runs once afterwards, rather
      // than stacking parallel COUNT queries.
      if (running) {
        again = true;
        return;
      }
      running = true;
      let last: OutboxCounts | null = null;
      try {
        const [pending, dead] = await Promise.all([layer.outbox.pendingCount(), layer.outbox.deadCount()]);
        last = { pending, failed: dead };
        if (active) setCounts(last);
      } catch (e) {
        // A status badge is not worth an error screen; the next tick recovers.
        if (__DEV__) console.warn("[sync] status poll failed:", e);
        // The released-shared-object teardown error is EXPECTED here (HANDOVER
        // §10 trap 7) and reportSyncError skips it; anything else is reported
        // once per session.
        reportSyncError(e, "sync-status");
      } finally {
        running = false;
      }
      if (!active) return;
      if (again) {
        again = false;
        void tick();
        return;
      }
      schedule(last);
    };

    // Refresh at once when the counts are known to have changed.
    const onEvent = () => void tick();
    const offChange = layer.outbox.onChange(onEvent);
    const offSettled = layer.engine.onSettled(onEvent);
    void tick();
    return () => {
      active = false;
      if (timer) clearTimeout(timer);
      offChange();
      offSettled();
    };
  }, [layer]);

  const retry = useCallback(() => {
    if (!layer) return;
    void (async () => {
      try {
        await layer.outbox.retryDead();
        await layer.engine.flush();
      } catch (e) {
        if (__DEV__) console.warn("[sync] retry failed:", e);
        reportSyncError(e, "sync-retry");
      }
    })();
  }, [layer]);

  return { pending: counts.pending, failed: counts.failed, synced: counts.pending === 0 && counts.failed === 0, retry };
}
