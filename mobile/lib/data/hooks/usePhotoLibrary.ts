import { useCallback } from "react";
import { useDataLayer } from "../DataProvider";
import { useFlush } from "./useFlush";
import { persistOutboxAttachment } from "../attachments";
import type { PhotoType } from "../repositories/jobPhotos";

// Write-side hook for job photos. addPhoto persists the picked/captured file to
// durable storage (so it survives until sync), queues the attachment-before-row
// insert, then flushes. Returns the new row id, the Storage object key, and the
// durable local uri so the screen can show the image immediately (incl. offline)
// keyed by that storage_path.
export interface PhotoLibrary {
  ready: boolean;
  addPhoto(input: {
    jobId: string;
    uploadedBy: string;
    photoType: PhotoType;
    sourceUri: string;
    ext?: string;
  }): Promise<{ id: string; storagePath: string; localUri: string; synced: boolean }>;
  deletePhoto(input: { id: string; storagePath: string }): Promise<{ synced: boolean }>;
}

export function usePhotoLibrary(): PhotoLibrary {
  const layer = useDataLayer();
  const flush = useFlush();

  const addPhoto = useCallback<PhotoLibrary["addPhoto"]>(async (input) => {
    if (!layer) throw new Error("Data layer not ready");
    const localUri = await persistOutboxAttachment(input.sourceUri, input.ext ?? "jpg");
    const { id, storagePath } = await layer.photos.add({
      jobId: input.jobId,
      uploadedBy: input.uploadedBy,
      photoType: input.photoType,
      localUri,
      ext: input.ext,
    });
    return { id, storagePath, localUri, synced: await flush() };
  }, [layer, flush]);

  const deletePhoto = useCallback<PhotoLibrary["deletePhoto"]>(async (input) => {
    if (!layer) throw new Error("Data layer not ready");
    await layer.photos.remove(input);
    return { synced: await flush() };
  }, [layer, flush]);

  return { ready: !!layer, addPhoto, deletePhoto };
}
