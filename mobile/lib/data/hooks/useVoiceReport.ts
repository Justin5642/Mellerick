import { useCallback } from "react";
import { useDataLayer } from "../DataProvider";
import { useFlush } from "./useFlush";
import { persistOutboxAttachment } from "../attachments";

// Write-side hook for the optional voice report. Persists the m4a recording to
// durable storage, enqueues the upload + transcribe, then flushes. Offline, the
// recording is queued and transcribes on reconnect (the transcript then appears
// on the next job-detail load). Returns whether it synced now.
export interface VoiceReport {
  ready: boolean;
  record(input: { jobId: string; recordedBy: string; sourceUri: string }): Promise<{ storagePath: string; synced: boolean }>;
}

export function useVoiceReport(): VoiceReport {
  const layer = useDataLayer();
  const flush = useFlush();

  const record = useCallback<VoiceReport["record"]>(async (input) => {
    if (!layer) throw new Error("Data layer not ready");
    const localUri = await persistOutboxAttachment(input.sourceUri, "m4a");
    const { storagePath } = await layer.voiceReport.record({
      jobId: input.jobId,
      recordedBy: input.recordedBy,
      localUri,
    });
    return { storagePath, synced: await flush() };
  }, [layer, flush]);

  return { ready: !!layer, record };
}
