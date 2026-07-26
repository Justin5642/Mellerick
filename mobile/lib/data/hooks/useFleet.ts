import { useCallback } from "react";
import { useDataLayer } from "../DataProvider";
import { useFlush } from "./useFlush";
import type { EquipmentInput } from "../repositories/fleet";

// Write-side hook for fleet/equipment (office/admin).
export function useFleet() {
  const layer = useDataLayer();
  const flush = useFlush();

  const run = useCallback(
    async <T,>(fn: (r: NonNullable<typeof layer>["equipment"]) => Promise<T>): Promise<{ result: T; synced: boolean }> => {
      if (!layer) throw new Error("Data layer not ready");
      const result = await fn(layer.equipment);
      return { result, synced: await flush() };
    },
    [layer, flush]
  );

  return {
    ready: !!layer,
    createEquipment: useCallback((i: EquipmentInput) => run((r) => r.createEquipment(i)), [run]),
    updateEquipment: useCallback((id: string, i: EquipmentInput) => run((r) => r.updateEquipment(id, i)), [run]),
    deactivateEquipment: useCallback((id: string) => run((r) => r.deactivateEquipment(id)), [run]),
  };
}
