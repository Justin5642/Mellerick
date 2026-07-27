import { useCallback } from "react";
import { useDataLayer } from "../DataProvider";
import { useFlush } from "./useFlush";

// Write-side hook for job notes. addNote queues a durable insert then flushes
// (syncs now when online, no-op offline), returning the new row id for the
// optimistic row and whether it synced.
export interface NotesComposer {
  ready: boolean;
  addNote(input: { jobId: string; authorId: string; content: string }): Promise<{ id: string; synced: boolean }>;
}

export function useJobNotes(): NotesComposer {
  const layer = useDataLayer();
  const flush = useFlush();

  const addNote = useCallback<NotesComposer["addNote"]>(async (input) => {
    if (!layer) throw new Error("Data layer not ready");
    const id = await layer.notes.add(input);
    return { id, synced: await flush() };
  }, [layer, flush]);

  return { ready: !!layer, addNote };
}
