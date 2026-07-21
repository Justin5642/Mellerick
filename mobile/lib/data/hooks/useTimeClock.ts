import { useCallback } from "react";
import { useDataLayer } from "../DataProvider";
import { netInfoConnectivity } from "../net/connectivity";
import type { ManualEntryInput, EditEntryInput } from "../repositories/timeEntries";

// Write-side hook for time tracking. Every action enqueues a durable outbox
// operation (works offline) and then flushes — draining immediately when online,
// a harmless no-op when offline. Each action resolves to whether the flush
// actually synced, so the screen knows whether to refresh from the server
// (online) or keep its optimistic local state (offline).
export interface TimeClock {
  ready: boolean;
  clockIn(input: { jobId: string; staffId: string }): Promise<{ id: string; synced: boolean }>;
  clockOut(input: { entryId: string; clockInIso: string }): Promise<{ synced: boolean }>;
  addManual(input: ManualEntryInput): Promise<{ id: string; synced: boolean }>;
  editEntry(input: EditEntryInput): Promise<{ synced: boolean }>;
  assignCostCenter(entryId: string, costCenterId: string | null): Promise<{ synced: boolean }>;
  remove(entryId: string): Promise<{ synced: boolean }>;
}

export function useTimeClock(): TimeClock {
  const layer = useDataLayer();

  // Flush and report whether we were online (so the caller can refresh from the
  // server only when the server actually has the write).
  const flush = useCallback(async (): Promise<boolean> => {
    if (!layer) return false;
    const online = await netInfoConnectivity.isOnline();
    await layer.engine.flush();
    return online;
  }, [layer]);

  const clockIn = useCallback<TimeClock["clockIn"]>(async (input) => {
    if (!layer) throw new Error("Data layer not ready");
    const id = await layer.timeEntries.clockIn(input);
    return { id, synced: await flush() };
  }, [layer, flush]);

  const clockOut = useCallback<TimeClock["clockOut"]>(async (input) => {
    if (!layer) throw new Error("Data layer not ready");
    await layer.timeEntries.clockOut(input);
    return { synced: await flush() };
  }, [layer, flush]);

  const addManual = useCallback<TimeClock["addManual"]>(async (input) => {
    if (!layer) throw new Error("Data layer not ready");
    const id = await layer.timeEntries.addManual(input);
    return { id, synced: await flush() };
  }, [layer, flush]);

  const editEntry = useCallback<TimeClock["editEntry"]>(async (input) => {
    if (!layer) throw new Error("Data layer not ready");
    await layer.timeEntries.editEntry(input);
    return { synced: await flush() };
  }, [layer, flush]);

  const assignCostCenter = useCallback<TimeClock["assignCostCenter"]>(async (entryId, costCenterId) => {
    if (!layer) throw new Error("Data layer not ready");
    await layer.timeEntries.assignCostCenter(entryId, costCenterId);
    return { synced: await flush() };
  }, [layer, flush]);

  const remove = useCallback<TimeClock["remove"]>(async (entryId) => {
    if (!layer) throw new Error("Data layer not ready");
    await layer.timeEntries.remove(entryId);
    return { synced: await flush() };
  }, [layer, flush]);

  return { ready: !!layer, clockIn, clockOut, addManual, editEntry, assignCostCenter, remove };
}
