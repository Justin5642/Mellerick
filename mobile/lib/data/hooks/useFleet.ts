import { useCallback } from "react";
import { useDataLayer } from "../DataProvider";
import { useFlush } from "./useFlush";
import { persistOutboxAttachment } from "../attachments";
import type { EquipmentInput, EquipmentExpenseInput } from "../repositories/fleet";

// Screen-facing add-expense args: the receipt is a raw picked file; the hook
// persists it to durable storage before queuing (mirrors useJobBilling).
export type AddEquipmentExpenseArgs = Omit<EquipmentExpenseInput, "receipt"> & {
  receipt?: { sourceUri: string; ext?: string } | null;
};

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
    assignEquipment: useCallback((id: string, assignedTo: string | null) => run((r) => r.assignEquipment(id, assignedTo)), [run]),
    addEquipmentExpense: useCallback(
      async (a: AddEquipmentExpenseArgs) => {
        const receipt = a.receipt
          ? { localUri: await persistOutboxAttachment(a.receipt.sourceUri, a.receipt.ext ?? "jpg"), ext: a.receipt.ext }
          : null;
        return run((r) => r.addEquipmentExpense({ ...a, receipt }));
      },
      [run]
    ),
    removeEquipmentExpense: useCallback((i: { id: string; receiptStoragePath?: string | null }) => run((r) => r.removeEquipmentExpense(i)), [run]),
  };
}
