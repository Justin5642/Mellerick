import { useCallback } from "react";
import { useDataLayer } from "../DataProvider";
import { useFlush } from "./useFlush";

export function useApprovals() {
  const layer = useDataLayer();
  const flush = useFlush();

  const run = useCallback(
    async <T,>(fn: (r: NonNullable<typeof layer>["approvals"]) => Promise<T>): Promise<{ result: T; synced: boolean }> => {
      if (!layer) throw new Error("Data layer not ready");
      const result = await fn(layer.approvals);
      return { result, synced: await flush() };
    },
    [layer, flush]
  );

  return {
    ready: !!layer,
    sendBackJob: useCallback((i: { jobId: string; note: string }) => run((r) => r.sendBackJob(i)), [run]),
  };
}
