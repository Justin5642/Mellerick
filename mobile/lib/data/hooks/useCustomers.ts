import { useCallback } from "react";
import { useDataLayer } from "../DataProvider";
import { useFlush } from "./useFlush";
import type { CustomerInput, SiteInput } from "../repositories/customers";

// Write-side hook for customers + sites (office/admin). Each action enqueues a
// durable outbox op then flushes; returns whether it synced now.
export function useCustomers() {
  const layer = useDataLayer();
  const flush = useFlush();

  const run = useCallback(
    async <T,>(fn: (r: NonNullable<typeof layer>["customers"]) => Promise<T>): Promise<{ result: T; synced: boolean }> => {
      if (!layer) throw new Error("Data layer not ready");
      const result = await fn(layer.customers);
      return { result, synced: await flush() };
    },
    [layer, flush]
  );

  return {
    ready: !!layer,
    createCustomer: useCallback((i: CustomerInput) => run((r) => r.createCustomer(i)), [run]),
    updateCustomer: useCallback((id: string, i: CustomerInput) => run((r) => r.updateCustomer(id, i)), [run]),
    deactivateCustomer: useCallback((id: string) => run((r) => r.deactivateCustomer(id)), [run]),
    createSite: useCallback((i: SiteInput) => run((r) => r.createSite(i)), [run]),
    updateSite: useCallback((id: string, i: SiteInput) => run((r) => r.updateSite(id, i)), [run]),
    removeSite: useCallback((id: string) => run((r) => r.removeSite(id)), [run]),
  };
}
