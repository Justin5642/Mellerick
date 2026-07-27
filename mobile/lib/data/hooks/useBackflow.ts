import { useCallback } from "react";
import { useDataLayer } from "../DataProvider";
import { useFlush } from "./useFlush";
import { persistOutboxAttachmentFromBase64 } from "../attachments";
import type { RegisterDeviceInput, LogTestInput } from "../repositories/backflow";

// Screen-facing log-test args: the signature arrives as a base64 PNG from
// react-native-signature-canvas; the hook writes it to durable storage before
// queuing (mirrors useJobBilling/useFleet receipts).
export type LogTestArgs = Omit<LogTestInput, "signature"> & { signatureBase64?: string | null };

export function useBackflow() {
  const layer = useDataLayer();
  const flush = useFlush();

  return {
    ready: !!layer,
    registerDevice: useCallback(
      async (input: RegisterDeviceInput): Promise<{ id: string; synced: boolean }> => {
        if (!layer) throw new Error("Data layer not ready");
        const id = await layer.backflow.registerDevice(input);
        return { id, synced: await flush() };
      },
      [layer, flush]
    ),
    logTest: useCallback(
      async ({ signatureBase64, ...rest }: LogTestArgs): Promise<{ id: string; synced: boolean }> => {
        if (!layer) throw new Error("Data layer not ready");
        const signature = signatureBase64
          ? { localUri: await persistOutboxAttachmentFromBase64(signatureBase64.replace(/^data:image\/png;base64,/, ""), "png") }
          : null;
        const { id } = await layer.backflow.logTest({ ...rest, signature });
        return { id, synced: await flush() };
      },
      [layer, flush]
    ),
  };
}
