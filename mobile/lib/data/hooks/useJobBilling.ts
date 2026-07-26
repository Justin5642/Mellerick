import { useCallback } from "react";
import { useDataLayer } from "../DataProvider";
import { useFlush } from "./useFlush";
import { persistOutboxAttachment } from "../attachments";
import type { JobLineItemInput, JobExpenseInput } from "../repositories/jobBilling";

// Screen-facing add-expense args: the receipt is a raw picked/captured file; the
// hook persists it to durable storage (so it survives until sync) before queuing.
export type AddExpenseArgs = Omit<JobExpenseInput, "receipt"> & {
  receipt?: { sourceUri: string; ext?: string } | null;
};

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
    addExpense: useCallback(
      async (a: AddExpenseArgs) => {
        const receipt = a.receipt
          ? { localUri: await persistOutboxAttachment(a.receipt.sourceUri, a.receipt.ext ?? "jpg"), ext: a.receipt.ext }
          : null;
        return run((r) => r.addExpense({ ...a, receipt }));
      },
      [run]
    ),
    removeExpense: useCallback((i: { id: string; receiptStoragePath?: string | null }) => run((r) => r.removeExpense(i)), [run]),
  };
}
