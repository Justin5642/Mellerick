import { useCallback } from "react";
import { useDataLayer } from "../DataProvider";
import { useFlush } from "./useFlush";
import type { JobLineItemInput } from "../repositories/jobBilling";

export function useJobBilling() {
  const layer = useDataLayer();
  const flush = useFlush();

  const run = useCallback(
    async <T,>(fn: (r: NonNullable<typeof layer>["jobBilling"]) => Promise<T>): Promise<{ result: T; synced: boolean }> => {
      if (!layer) throw new Error("Data layer not ready");
      const result = await fn(layer.jobBilling);
      return { result, synced: await flush() };
    },
    [layer, flush]
  );

  return {
    ready: !!layer,
    addLineItem: useCallback((i: JobLineItemInput) => run((r) => r.addLineItem(i)), [run]),
    removeLineItem: useCallback((id: string) => run((r) => r.removeLineItem(id)), [run]),
  };
}
