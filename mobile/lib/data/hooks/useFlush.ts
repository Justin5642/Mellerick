import { useCallback } from "react";
import { useDataLayer } from "../DataProvider";
import { netInfoConnectivity } from "../net/connectivity";

// Drain the outbox now and report whether we were online — so a screen can
// decide whether to refresh from the server (online) or keep its optimistic
// local state (offline). Shared by every write hook.
export function useFlush(): () => Promise<boolean> {
  const layer = useDataLayer();
  return useCallback(async () => {
    if (!layer) return false;
    const online = await netInfoConnectivity.isOnline();
    await layer.engine.flush(); // drains now if online; harmless no-op offline
    return online;
  }, [layer]);
}
