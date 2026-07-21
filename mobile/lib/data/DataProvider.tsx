import React, { createContext, useContext, useEffect, useState } from "react";
import { SqliteOutboxStore } from "./outbox/sqliteStore";
import { supabaseGateway, apiBridge } from "./gateway.supabase";
import { netInfoConnectivity } from "./net/connectivity";
import { createDataLayer, type DataLayer } from "./createDataLayer";

// Nullable while the SQLite outbox opens (a few ms on cold start). Consumers
// guard on null; write hooks stay disabled until the layer is ready.
const DataContext = createContext<DataLayer | null>(null);

// App-root provider: opens the durable outbox, wires the real Supabase gateway /
// api-bridge / connectivity into the offline stack, and starts the sync engine
// (which drains anything queued while the app was closed, then on every
// reconnect). Stops the engine on unmount.
export function DataProvider({ children }: { children: React.ReactNode }) {
  const [layer, setLayer] = useState<DataLayer | null>(null);

  useEffect(() => {
    let cancelled = false;
    let built: DataLayer | undefined;
    (async () => {
      const store = await SqliteOutboxStore.open();
      if (cancelled) return;
      built = createDataLayer({
        store,
        gateway: supabaseGateway,
        api: apiBridge,
        connectivity: netInfoConnectivity,
      });
      built.engine.start();
      setLayer(built);
    })();
    return () => {
      cancelled = true;
      built?.engine.stop();
    };
  }, []);

  return <DataContext.Provider value={layer}>{children}</DataContext.Provider>;
}

// The wired stack, or null while still initializing.
export function useDataLayer(): DataLayer | null {
  return useContext(DataContext);
}
