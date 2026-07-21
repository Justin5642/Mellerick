import { useEffect, useState } from "react";
import { useDataLayer } from "./DataProvider";

export interface SyncStatus {
  /** Operations still outstanding (pending + failed + inflight). */
  pending: number;
  /** Operations currently in backoff after a failure. */
  failed: number;
  /** True while the outbox is empty (everything synced). */
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
      const [pending, failed] = await Promise.all([layer.outbox.pendingCount(), layer.outbox.failedCount()]);
      if (active) setStatus({ pending, failed, synced: pending === 0 });
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
