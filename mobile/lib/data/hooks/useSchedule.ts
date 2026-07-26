import { useCallback } from "react";
import { useDataLayer } from "../DataProvider";
import { useFlush } from "./useFlush";

export function useSchedule() {
  const layer = useDataLayer();
  const flush = useFlush();

  const run = useCallback(
    async <T,>(fn: (r: NonNullable<typeof layer>["schedule"]) => Promise<T>): Promise<{ synced: boolean }> => {
      if (!layer) throw new Error("Data layer not ready");
      await fn(layer.schedule);
      return { synced: await flush() };
    },
    [layer, flush]
  );

  return {
    ready: !!layer,
    reassign: useCallback((jobId: string, assignedTo: string | null) => run((r) => r.reassign(jobId, assignedTo)), [run]),
    reschedule: useCallback(
      (jobId: string, scheduledStartIso: string, scheduledEndIso: string | null) => run((r) => r.reschedule(jobId, scheduledStartIso, scheduledEndIso)),
      [run]
    ),
  };
}
