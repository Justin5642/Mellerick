import { useCallback } from "react";
import { useDataLayer } from "../DataProvider";
import { useFlush } from "./useFlush";
import type { JobFieldsInput, CreateJobInput } from "../repositories/jobs";

export function useJobEdit() {
  const layer = useDataLayer();
  const flush = useFlush();

  return {
    ready: !!layer,
    updateFields: useCallback(
      async (jobId: string, fields: JobFieldsInput): Promise<{ synced: boolean }> => {
        if (!layer) throw new Error("Data layer not ready");
        await layer.jobs.updateFields(jobId, fields);
        return { synced: await flush() };
      },
      [layer, flush]
    ),
    createJob: useCallback(
      async (input: CreateJobInput): Promise<{ id: string; synced: boolean }> => {
        if (!layer) throw new Error("Data layer not ready");
        const id = await layer.jobs.createJob(input);
        return { id, synced: await flush() };
      },
      [layer, flush]
    ),
  };
}
