import { useCallback } from "react";
import { useDataLayer } from "../DataProvider";
import { useFlush } from "./useFlush";
import { persistOutboxAttachmentFromBase64 } from "../attachments";

// Write-side hook for customer sign-off / job completion. Persists the signature
// PNG (base64 from the canvas) to durable storage, enqueues the compound
// job-completion write, then flushes.
export interface Signoff {
  ready: boolean;
  signOff(input: {
    jobId: string;
    uploadedBy: string;
    signerName: string;
    signatureBase64: string;
    signedOffDate: string;
  }): Promise<{ photoId: string; storagePath: string; synced: boolean }>;
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
    return { photoId, storagePath, synced: await flush() };
  }, [layer, flush]);

  return { ready: !!layer, signOff };
}
