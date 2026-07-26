import { useCallback } from "react";
import { useDataLayer } from "../DataProvider";
import { useFlush } from "./useFlush";
import type { RegisterDeviceInput } from "../repositories/backflow";

export function useBackflow() {
  const layer = useDataLayer();
  const flush = useFlush();

  return {
    ready: !!layer,
    registerDevice: useCallback(
      async (input: RegisterDeviceInput): Promise<{ id: string; synced: boolean }> => {
        if (!layer) throw new Error("Data layer not ready");
        const id = await layer.backflow.registerDevice(input);
        return { id, synced: await flush() };
      },
      [layer, flush]
    ),
  };
}
