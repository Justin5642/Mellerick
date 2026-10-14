import { useCallback } from "react";
import { useDataLayer } from "../DataProvider";
import { useFlush } from "./useFlush";
import type { ScheduleColumns } from "../../scheduling";
import type { RescheduleFlags } from "../repositories/schedule";

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
      (jobId: string, scheduledStartIso: string, scheduledEndIso: string | null, flags?: RescheduleFlags) =>
        run((r) => r.reschedule(jobId, scheduledStartIso, scheduledEndIso, flags)),
      [run]
    ),
    clearSchedule: useCallback((jobId: string) => run((r) => r.clearSchedule(jobId)), [run]),
    schedule: useCallback(
      (jobId: string, staffIds: string[], columns: ScheduleColumns, costCenterId: string | null = null) =>
        run((r) => r.schedule(jobId, staffIds, columns, costCenterId)),
      [run]
    ),
  };
}
