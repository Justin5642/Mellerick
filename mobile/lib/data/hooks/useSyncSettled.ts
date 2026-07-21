import { useEffect, useRef } from "react";
import { useDataLayer } from "../DataProvider";

// Run `cb` after each sync drain completes (queued writes have actually reached
// the server), so a screen can reconcile its list at the right moment instead of
// on a was-online guess. Uses a ref so the subscription isn't torn down when cb
// identity changes each render.
export function useSyncSettled(cb: () => void): void {
  const layer = useDataLayer();
  const ref = useRef(cb);
  ref.current = cb;
  useEffect(() => {
    if (!layer) return;
    return layer.engine.onSettled(() => ref.current());
  }, [layer]);
}
