import { useCallback } from "react";
import { useDataLayer } from "../DataProvider";
import { useFlush } from "./useFlush";

// Write-side hook for stage-based job notes. Each call queues a durable write
// then flushes (syncs now when online, no-op offline).
//
// addNote returns the new row id for the optimistic row and whether it synced.
// editNote / deleteNote return the row's outcome after the flush: "failed"
// means the server refused it (RLS 0074: your own notes, or office/admin) and
// the screen should say so; "pending" means it is still queued (offline).
export type StageNoteWriteOutcome = "settled" | "pending" | "failed";

export interface StageNotesComposer {
  ready: boolean;
  addNote(input: { jobId: string; stage: string; authorId: string; content: string }): Promise<{ id: string; synced: boolean }>;
  editNote(input: { id: string; content: string }): Promise<StageNoteWriteOutcome>;
  deleteNote(input: { id: string }): Promise<StageNoteWriteOutcome>;
}

export function useJobStageNotes(): StageNotesComposer {
  const layer = useDataLayer();
  const flush = useFlush();

  const addNote = useCallback<StageNotesComposer["addNote"]>(async (input) => {
    if (!layer) throw new Error("Data layer not ready");
    const id = await layer.stageNotes.add(input);
    return { id, synced: await flush() };
  }, [layer, flush]);

  const editNote = useCallback<StageNotesComposer["editNote"]>(async (input) => {
    if (!layer) throw new Error("Data layer not ready");
    await layer.stageNotes.update(input);
    await flush();
    return layer.outbox.writeStatus(input.id);
  }, [layer, flush]);

  const deleteNote = useCallback<StageNotesComposer["deleteNote"]>(async (input) => {
    if (!layer) throw new Error("Data layer not ready");
    await layer.stageNotes.remove(input);
    await flush();
    return layer.outbox.writeStatus(input.id);
  }, [layer, flush]);

  return { ready: !!layer, addNote, editNote, deleteNote };
}
