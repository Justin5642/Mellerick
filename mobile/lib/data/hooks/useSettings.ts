import { useCallback } from "react";
import { useDataLayer } from "../DataProvider";
import { useFlush } from "./useFlush";
import type { VariationTypeInput, CostCentreTemplateInput } from "../repositories/settings";

export function useSettings() {
  const layer = useDataLayer();
  const flush = useFlush();

  const run = useCallback(
    async <T,>(fn: (r: NonNullable<typeof layer>["settings"]) => Promise<T>): Promise<{ result: T; synced: boolean }> => {
      if (!layer) throw new Error("Data layer not ready");
      const result = await fn(layer.settings);
      return { result, synced: await flush() };
    },
    [layer, flush]
  );

  return {
    ready: !!layer,
    createVariationType: useCallback((i: VariationTypeInput) => run((r) => r.createVariationType(i)), [run]),
    updateVariationType: useCallback((id: string, i: VariationTypeInput) => run((r) => r.updateVariationType(id, i)), [run]),
    setVariationTypeActive: useCallback((id: string, active: boolean) => run((r) => r.setVariationTypeActive(id, active)), [run]),
    createCostCentreTemplate: useCallback((i: CostCentreTemplateInput) => run((r) => r.createCostCentreTemplate(i)), [run]),
    setCostCentreTemplateActive: useCallback((id: string, active: boolean) => run((r) => r.setCostCentreTemplateActive(id, active)), [run]),
  };
}
