import { useCallback } from "react";
import { useDataLayer } from "../DataProvider";
import { useFlush } from "./useFlush";
import { persistOutboxAttachment } from "../attachments";

// Screen-facing tech submit args: the photo is a raw picked file; the hook copies
// it to durable storage before queuing (mirrors useJobBilling/useFleet).
export type SubmitVariationArgs = {
  jobId: string;
  variationTypeId: string | null;
  customName: string | null;
  description: string | null;
  quantity: number;
  unit: string;
  loggedBy: string;
  photo?: { sourceUri: string; ext?: string } | null;
};

// Write-side hook for variations: technician submit + office/admin pricing/approval.
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
    submitVariation: useCallback(
      async (a: SubmitVariationArgs) => {
        const photo = a.photo
          ? { localUri: await persistOutboxAttachment(a.photo.sourceUri, a.photo.ext ?? "jpg"), ext: a.photo.ext }
          : null;
        return run((r) => r.submitVariation({ ...a, photo }));
      },
      [run]
    ),
    priceAndApprove: useCallback(
      (i: { id: string; rate: number; quantity: number; approvedBy: string; notes?: string | null }) => run((r) => r.priceAndApprove(i)),
      [run]
    ),
    reject: useCallback((i: { id: string; approvedBy: string; notes?: string | null }) => run((r) => r.reject(i)), [run]),
  };
}
