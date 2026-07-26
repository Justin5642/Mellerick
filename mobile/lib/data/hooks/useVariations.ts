import { useCallback } from "react";
import { useDataLayer } from "../DataProvider";
import { useFlush } from "./useFlush";

// Write-side hook for office/admin variation pricing + approval.
export function useVariations() {
  const layer = useDataLayer();
  const flush = useFlush();

  const run = useCallback(
    async <T,>(fn: (r: NonNullable<typeof layer>["variations"]) => Promise<T>): Promise<{ result: T; synced: boolean }> => {
      if (!layer) throw new Error("Data layer not ready");
      const result = await fn(layer.variations);
      return { result, synced: await flush() };
    },
    [layer, flush]
  );

  return {
    ready: !!layer,
    priceAndApprove: useCallback(
      (i: { id: string; rate: number; quantity: number; approvedBy: string; notes?: string | null }) => run((r) => r.priceAndApprove(i)),
      [run]
    ),
    reject: useCallback((i: { id: string; approvedBy: string; notes?: string | null }) => run((r) => r.reject(i)), [run]),
  };
}
