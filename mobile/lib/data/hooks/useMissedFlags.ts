import { useCallback, useEffect, useState } from "react";
import { useDataLayer } from "../DataProvider";
import { useFlush } from "./useFlush";
import { queuedMissedFlags, type QueuedMissed } from "../../missedQueue";

/**
 * "Didn't make it" (0121 (draft)): flag or undo a booking through the outbox, and the
 * changes still queued on this phone — so a screen shows the tech's flag at
 * once, offline included, until the booking syncs back with it.
 */
export function useMissedFlags() {
  const layer = useDataLayer();
  const flush = useFlush();
  const [queued, setQueued] = useState<Map<string, QueuedMissed>>(new Map());

  useEffect(() => {
    if (!layer) return;
    let live = true;
    const read = () => {
      layer.outbox
        .snapshot()
        .then((ops) => live && setQueued(queuedMissedFlags(ops)))
        .catch(() => {});
    };
    read();
    const off = layer.outbox.onChange(read);
    return () => {
      live = false;
      off();
    };
  }, [layer]);

  const flag = useCallback(
    async (jobId: string, bookingId: string, reason: string, note: string | null) => {
      if (!layer) throw new Error("Data layer not ready");
      await layer.schedule.flagMissed(jobId, bookingId, reason, note);
      return { synced: await flush() };
    },
    [layer, flush]
  );

  const clear = useCallback(
    async (jobId: string, bookingId: string) => {
      if (!layer) throw new Error("Data layer not ready");
      await layer.schedule.clearMissed(jobId, bookingId);
      return { synced: await flush() };
    },
    [layer, flush]
  );

  return { queued, flag, clear };
}
