import { useCallback } from "react";
import { useDataLayer } from "../DataProvider";
import { useFlush } from "./useFlush";
import type { ScheduleColumns } from "../../scheduling";
import type { BookingPatch, RescheduleFlags } from "../repositories/schedule";

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

  // The new booking ids come back so the screen can show the rows at once —
  // offline they reach the device mirror only after they have synced.
  const addBookings = useCallback(
    async (jobId: string, staffIds: string[], columns: ScheduleColumns, costCenterId: string | null) => {
      if (!layer) throw new Error("Data layer not ready");
      const ids = await layer.schedule.addBookings(jobId, staffIds, columns, costCenterId);
      return { ids, synced: await flush() };
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
    setCrew: useCallback((jobId: string, staffIds: string[]) => run((r) => r.setCrew(jobId, staffIds)), [run]),
    addBookings,
    updateBooking: useCallback(
      (jobId: string, bookingId: string, patch: BookingPatch) => run((r) => r.updateBooking(jobId, bookingId, patch)),
      [run]
    ),
    deleteBooking: useCallback((jobId: string, bookingId: string) => run((r) => r.deleteBooking(jobId, bookingId)), [run]),
    schedule: useCallback(
      (jobId: string, staffIds: string[], columns: ScheduleColumns, costCenterId: string | null = null) =>
        run((r) => r.schedule(jobId, staffIds, columns, costCenterId)),
      [run]
    ),
  };
}
