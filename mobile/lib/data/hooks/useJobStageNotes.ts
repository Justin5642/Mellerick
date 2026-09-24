import { useCallback } from "react";
import { useDataLayer } from "../DataProvider";
import { useFlush } from "./useFlush";

// Write-side hook for stage-based job notes. addNote queues a durable insert
// then flushes (syncs now when online, no-op offline), returning the new row
// id for the optimistic row and whether it synced.
export interface StageNotesComposer {
  ready: boolean;
  addNote(input: { jobId: string; stage: string; authorId: string; content: string }): Promise<{ id: string; synced: boolean }>;
}

export function useJobStageNotes(): StageNotesComposer {
  const layer = useDataLayer();
  const flush = useFlush();

  const addNote = useCallback<StageNotesComposer["addNote"]>(async (input) => {
    if (!layer) throw new Error("Data layer not ready");
    const id = await layer.stageNotes.add(input);
    return { id, synced: await flush() };
  }, [layer, flush]);

  return { ready: !!layer, addNote };
}
