import { useEffect, useState } from "react";
import { useDataLayer } from "./DataProvider";

export interface SyncStatus {
  /** Operations still outstanding and being retried (pending + failed + inflight). */
  pending: number;
  /** Operations that gave up retrying (terminal) — needs user attention. */
  failed: number;
  /** True while nothing is outstanding and nothing is dead. */
  synced: boolean;
}

// Polls the outbox so a header badge can show pending/failed sync state. Cheap
// COUNT queries; the interval is coarse because this only drives a status pill.
export function useSyncStatus(pollMs = 3000): SyncStatus {
  const layer = useDataLayer();
  const [status, setStatus] = useState<SyncStatus>({ pending: 0, failed: 0, synced: true });

  useEffect(() => {
    if (!layer) return;
    let active = true;
    const tick = async () => {
      const [pending, dead] = await Promise.all([layer.outbox.pendingCount(), layer.outbox.deadCount()]);
      if (active) setStatus({ pending, failed: dead, synced: pending === 0 && dead === 0 });
    };
    void tick();
    const iv = setInterval(tick, pollMs);
    return () => {
      active = false;
      clearInterval(iv);
    };
  }, [layer, pollMs]);

  return status;
}
