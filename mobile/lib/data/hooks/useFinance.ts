import { useCallback } from "react";
import { useDataLayer } from "../DataProvider";
import { useFlush } from "./useFlush";
import type {
  CreateInvoiceInput,
  EditInvoiceInput,
  CreateQuoteInput,
  EditQuoteInput,
  PricingItemInput,
} from "../repositories/finance";

// Write-side hook for the financial builders. Each action enqueues durable
// outbox operations then flushes; office/admin only (RLS + the screens sit
// behind Stack.Protected). Returns synced=whether it reached the server now.
export function useFinance() {
  const layer = useDataLayer();
  const flush = useFlush();

  const run = useCallback(
    async <T,>(fn: (f: NonNullable<typeof layer>["finance"]) => Promise<T>): Promise<{ result: T; synced: boolean }> => {
      if (!layer) throw new Error("Data layer not ready");
      const result = await fn(layer.finance);
      return { result, synced: await flush() };
    },
    [layer, flush]
  );

  return {
    ready: !!layer,
    createInvoice: useCallback((i: CreateInvoiceInput) => run((f) => f.createInvoice(i)), [run]),
    editInvoice: useCallback((i: EditInvoiceInput) => run((f) => f.editInvoice(i)), [run]),
    createQuote: useCallback((i: CreateQuoteInput) => run((f) => f.createQuote(i)), [run]),
    editQuote: useCallback((i: EditQuoteInput) => run((f) => f.editQuote(i)), [run]),
    setQuoteStatus: useCallback(
      (id: string, s: "draft" | "sent" | "accepted" | "declined") => run((f) => f.setQuoteStatus(id, s)),
      [run]
    ),
    createPricingItem: useCallback((i: PricingItemInput) => run((f) => f.createPricingItem(i)), [run]),
    updatePricingItem: useCallback((id: string, i: PricingItemInput) => run((f) => f.updatePricingItem(id, i)), [run]),
    deactivatePricingItem: useCallback((id: string) => run((f) => f.deactivatePricingItem(id)), [run]),
  };
}
