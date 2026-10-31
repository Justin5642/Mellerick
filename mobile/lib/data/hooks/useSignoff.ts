import { useCallback } from "react";
import { useDataLayer } from "../DataProvider";
import { useFlush } from "./useFlush";
import { persistOutboxAttachmentFromBase64 } from "../attachments";
import { getOpenWorkEntryOnJob } from "../reads/clock";

// Write-side hook for customer sign-off / job completion. Persists the signature
// PNG (base64 from the canvas) to durable storage, enqueues the compound
// job-completion write, clocks the person signing off out of the job if they
// are still on the clock there, then flushes.
export interface Signoff {
  ready: boolean;
  signOff(input: {
    jobId: string;
    uploadedBy: string;
    signerName: string;
    signatureBase64: string;
    signedOffDate: string;
  }): Promise<{ photoId: string; storagePath: string; clockedOut: boolean; synced: boolean }>;
}

export function useSignoff(): Signoff {
  const layer = useDataLayer();
  const flush = useFlush();

  const signOff = useCallback<Signoff["signOff"]>(async (input) => {
    if (!layer) throw new Error("Data layer not ready");
    const localUri = await persistOutboxAttachmentFromBase64(input.signatureBase64, "png");
    const { photoId, storagePath } = await layer.signature.signOff({
      jobId: input.jobId,
      uploadedBy: input.uploadedBy,
      signerName: input.signerName,
      localUri,
      signedOffDate: input.signedOffDate,
    });
    // The job is finished, so the clock stops with it (31 Oct 2026). Before
    // this, a sign-off left the entry running; on the day's last job tracking
    // also switched off, so nothing ever closed it. Only the signer's own
    // entry: the rest of the crew clock off themselves (or leave site). A
    // failed lookup must not undo a sign-off that is already queued.
    let clockedOut = false;
    try {
      const open = await getOpenWorkEntryOnJob(input.uploadedBy, input.jobId);
      if (open) {
        await layer.timeEntries.clockOut({ entryId: open.id, clockInIso: open.clockInIso });
        clockedOut = true;
      }
    } catch (e) {
      console.warn("[signoff] could not clock out after sign-off:", e);
    }
    return { photoId, storagePath, clockedOut, synced: await flush() };
  }, [layer, flush]);

  return { ready: !!layer, signOff };
}
