import * as FileSystem from "expo-file-system/legacy";
import { cryptoIdGen } from "./ids";

// Durable staging dir for queued attachments, under app documents (persistent),
// NOT cache/temp (which the OS can purge at any time).
const DIR = `${FileSystem.documentDirectory}outbox-attachments/`;

// Copy a picked/captured file out of its volatile picker/cache location into the
// durable staging dir, so a queued photo survives app restarts and OS cache
// eviction until the outbox uploads it. Returns the durable file uri, which
// becomes the operation's attachmentLocalPath. The processor deletes it via
// gateway.cleanupAttachment once the write has synced.
export async function persistOutboxAttachment(sourceUri: string, ext = "jpg"): Promise<string> {
  // makeDirectoryAsync throws if it already exists even with intermediates on
  // some platforms — tolerate it.
  await FileSystem.makeDirectoryAsync(DIR, { intermediates: true }).catch(() => {});
  const dest = `${DIR}${cryptoIdGen.newId()}.${ext}`;
  await FileSystem.copyAsync({ from: sourceUri, to: dest });
  return dest;
}
