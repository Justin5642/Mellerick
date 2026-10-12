import { useCallback } from "react";
import { useDataLayer } from "../DataProvider";
import { useFlush } from "./useFlush";
import { persistOutboxAttachment } from "../attachments";
import { audioExtension } from "../../dictation";

// Write-side hook for the optional voice report. Copies the recording (when the
// phone kept one) to durable storage, enqueues the upload + save, then flushes.
// Offline, it all waits in the outbox and saves on reconnect.
export interface VoiceReport {
  ready: boolean;
  record(input: {
    jobId: string;
    recordedBy: string;
    transcript: string;
    sourceUri: string | null;
  }): Promise<{ storagePath: string | null; synced: boolean }>;
}

export function useVoiceReport(): VoiceReport {
  const layer = useDataLayer();
  const flush = useFlush();

  const record = useCallback<VoiceReport["record"]>(async (input) => {
    if (!layer) throw new Error("Data layer not ready");
    const audioExt = input.sourceUri ? audioExtension(input.sourceUri) : undefined;
    const localUri = input.sourceUri ? await persistOutboxAttachment(input.sourceUri, audioExt) : null;
    const { storagePath } = await layer.voiceReport.record({
      jobId: input.jobId,
      recordedBy: input.recordedBy,
      transcript: input.transcript,
      localUri,
      audioExt,
    });
    return { storagePath, synced: await flush() };
  }, [layer, flush]);

  return { ready: !!layer, record };
}
