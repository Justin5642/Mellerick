import { useCallback } from "react";
import { useDataLayer } from "../DataProvider";

// After a write + flush, ask whether the row's mutation was actually ACCEPTED by
// the server — not merely whether we were online (which is all `synced` reports,
// see useFlush). Lets a create-then-navigate screen avoid routing to a detail for
// a row the server rejected, and surface a clear error instead. "settled" = the
// write is on the server; "pending" = still queued (offline / dependency);
// "failed" = the server rejected it (it's dead-lettering / retrying).
export function useWriteOutcome(): (rowId: string) => Promise<"settled" | "pending" | "failed"> {
  const layer = useDataLayer();
  return useCallback(
    async (rowId: string) => {
      if (!layer) return "pending";
      return layer.outbox.writeStatus(rowId);
    },
    [layer]
  );
}
