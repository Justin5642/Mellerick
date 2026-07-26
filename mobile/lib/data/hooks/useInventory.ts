import { useCallback } from "react";
import { useDataLayer } from "../DataProvider";
import { useFlush } from "./useFlush";
import type { InventoryInput } from "../repositories/inventory";

// Write-side hook for inventory (office/admin).
export function useInventory() {
  const layer = useDataLayer();
  const flush = useFlush();

  const run = useCallback(
    async <T,>(fn: (r: NonNullable<typeof layer>["inventory"]) => Promise<T>): Promise<{ result: T; synced: boolean }> => {
      if (!layer) throw new Error("Data layer not ready");
      const result = await fn(layer.inventory);
      return { result, synced: await flush() };
    },
    [layer, flush]
  );

  return {
    ready: !!layer,
    createItem: useCallback((i: InventoryInput) => run((r) => r.createItem(i)), [run]),
    updateItem: useCallback((id: string, i: InventoryInput) => run((r) => r.updateItem(id, i)), [run]),
    deactivateItem: useCallback((id: string) => run((r) => r.deactivateItem(id)), [run]),
    adjustQuantity: useCallback((id: string, q: number) => run((r) => r.adjustQuantity(id, q)), [run]),
  };
}
