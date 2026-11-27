import * as FileSystem from "expo-file-system/legacy";
import { prepareImage } from "./imageUpload";

// Files from the phone (Files / iCloud Drive / Downloads / Google Drive) for
// the office's uploads: job documents, a supplier invoice on the PO tab, a
// fleet service invoice or equipment document, and invoice-email attachments.
// Until Nov 2026 the binary had no document picker, so PDFs could only be
// uploaded on the website.
//
// LAZY NATIVE MODULE. expo-document-picker is a native module, so it only
// exists in a binary built after it was added (Nov 2026). An OTA update that
// reaches an older binary would otherwise throw at import and take the screen
// down; instead `documentPickerAvailable()` is false and callers hide the
// "Choose file" button (same pattern as lib/dictation.ts).
//
// Every upload route checks the bytes itself (sniffed — PDF/JPEG/PNG/WebP,
// ≤ 3 MB as base64 in the request); the checks here only give a clear sentence
// before anything is read or sent.

type DocumentPickerModule = typeof import("expo-document-picker");

let pickerModule: DocumentPickerModule | null | undefined;
function picker(): DocumentPickerModule | null {
  if (pickerModule === undefined) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mod = require("expo-document-picker") as DocumentPickerModule;
      pickerModule = typeof mod?.getDocumentAsync === "function" ? mod : null;
    } catch {
      pickerModule = null;
    }
  }
  return pickerModule;
}

/** False on a binary built before expo-document-picker was added — hide "Choose file". */
export function documentPickerAvailable(): boolean {
  return picker() !== null;
}

/** Tests only: forget the cached module so a different mock can be loaded. */
export function __resetDocumentPickerForTests(): void {
  pickerModule = undefined;
}

/** The requests travel as base64 and Vercel caps a request at 4.5 MB — every upload route takes 3 MB. */
export const MAX_PICKED_UPLOAD_BYTES = 3 * 1024 * 1024;

/** What the upload routes accept (they sniff the bytes): PDF and photos. */
export const UPLOAD_PICKER_TYPES = ["application/pdf", "image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"];

export const UPLOAD_TYPES_HINT = "PDF or a photo (JPEG, PNG, WebP)";

export interface PickedFile {
  name: string;
  uri: string;
  /** Bytes, when the OS reported it. */
  size: number | null;
  mimeType: string | null;
}

/** The picker's answer as plain files; null when cancelled or nothing was picked. */
export function mapPickerResult(result: unknown): PickedFile[] | null {
  const r = result as { canceled?: boolean; assets?: unknown } | null | undefined;
  if (!r || r.canceled || !Array.isArray(r.assets) || r.assets.length === 0) return null;
  const files: PickedFile[] = [];
  for (const a of r.assets as Record<string, unknown>[]) {
    if (!a || typeof a.uri !== "string" || !a.uri) continue;
    const name = typeof a.name === "string" && a.name.trim() ? a.name.trim() : (a.uri.split("/").pop() ?? "").split("?")[0] || "file";
    files.push({
      name,
      uri: a.uri,
      size: typeof a.size === "number" && Number.isFinite(a.size) && a.size >= 0 ? a.size : null,
      mimeType: typeof a.mimeType === "string" && a.mimeType ? a.mimeType.toLowerCase() : null,
    });
  }
  return files.length ? files : null;
}

export function formatPickedBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

const extOf = (name: string) => (/\.([a-z0-9]{1,5})$/i.exec(name)?.[1] ?? "").toLowerCase();

/** A photo the phone can shrink to a JPEG first (HEIC from an iPhone included). */
export function isPickedImage(file: Pick<PickedFile, "name" | "mimeType">): boolean {
  if (file.mimeType?.startsWith("image/")) return true;
  return ["jpg", "jpeg", "png", "webp", "heic", "heif"].includes(extOf(file.name));
}

export function isPickedPdf(file: Pick<PickedFile, "name" | "mimeType">): boolean {
  return file.mimeType === "application/pdf" || extOf(file.name) === "pdf";
}

export function fileTooBigMessage(name: string, bytes: number, max = MAX_PICKED_UPLOAD_BYTES): string {
  return `${name} is ${formatPickedBytes(bytes)} — the phone can send ${formatPickedBytes(max)} at most. Upload it on the website instead.`;
}

/**
 * Why a picked file can't go to a PDF-or-photo upload, before it is read —
 * null when it may. A photo over the limit is fine: it is shrunk first.
 */
export function pickedUploadProblem(file: PickedFile, max = MAX_PICKED_UPLOAD_BYTES): string | null {
  const image = isPickedImage(file);
  if (!image && !isPickedPdf(file)) return `${file.name} can't be uploaded here — choose a ${UPLOAD_TYPES_HINT}.`;
  if (!image && file.size != null && file.size > max) return fileTooBigMessage(file.name, file.size, max);
  return null;
}

export type UploadKind = "pdf" | "jpeg" | "png" | "webp";

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** The first bytes of a base64 string (no atob — not every JS engine has it). */
export function base64Head(b64: string, count = 12): number[] {
  const out: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const ch of b64) {
    if (out.length >= count) break;
    if (ch === "=") break;
    const v = B64.indexOf(ch);
    if (v < 0) continue;
    buffer = (buffer << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((buffer >> bits) & 0xff);
    }
  }
  return out;
}

/** What the bytes really are — the routes' own sniff (PDF, JPEG, PNG, WebP). */
export function sniffBase64Kind(b64: string): UploadKind | null {
  const h = base64Head(b64, 12);
  const at = (i: number, ...bytes: number[]) => bytes.every((b, j) => h[i + j] === b);
  if (at(0, 0x25, 0x50, 0x44, 0x46, 0x2d)) return "pdf";
  if (at(0, 0xff, 0xd8, 0xff)) return "jpeg";
  if (at(0, 0x89, 0x50, 0x4e, 0x47)) return "png";
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return "webp";
  return null;
}

export const kindExtension = (kind: UploadKind): string => (kind === "jpeg" ? "jpg" : kind);

/** Bytes a base64 string decodes to. */
export function base64ByteLength(b64: string): number {
  return Math.floor((b64.length * 3) / 4) - (b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0);
}

/** "Plans sheet 2.pdf" → "Plans sheet 2" (the editable name on the upload sheet). */
export function pickedBaseName(name: string): string {
  return name.replace(/\.[A-Za-z0-9]{1,5}$/, "").trim();
}

/** The file name to send: the typed label (or the original name) with the extension the bytes have. */
export function uploadFileName(label: string, originalName: string, kind: UploadKind): string {
  const base = (label.trim() || pickedBaseName(originalName) || "file").replace(/[\\/:*?"<>|]/g, "").slice(0, 80).trim() || "file";
  return `${base}.${kindExtension(kind)}`;
}

/** Opens the system file picker. Null when cancelled. Throws when the binary has no picker. */
export async function pickDocuments(opts: { types?: string[]; multiple?: boolean } = {}): Promise<PickedFile[] | null> {
  const mod = picker();
  if (!mod) throw new Error("Choosing files needs the latest version of the app.");
  const result = await mod.getDocumentAsync({
    type: opts.types && opts.types.length ? opts.types : "*/*",
    multiple: opts.multiple ?? false,
    copyToCacheDirectory: true,
  });
  return mapPickerResult(result);
}

/** The picker's cache copy is not needed once read. Best-effort. */
async function forget(uri: string): Promise<void> {
  try {
    await FileSystem.deleteAsync(uri, { idempotent: true });
  } catch {
    // The OS clears the cache anyway.
  }
}

/** A picked file's raw bytes as base64 (any type — invoice-email attachments). */
export async function readPickedBase64(file: PickedFile): Promise<string> {
  try {
    return await FileSystem.readAsStringAsync(file.uri, { encoding: FileSystem.EncodingType.Base64 });
  } finally {
    void forget(file.uri);
  }
}

export interface ReadyUpload {
  /** The name picked, unchanged (shown on the sheet). */
  originalName: string;
  base64: string;
  bytes: number;
  kind: UploadKind;
}

/**
 * Reads a picked file for a PDF-or-photo upload route: a photo is shrunk to a
 * JPEG (lib/imageUpload.ts, as the camera path does), a PDF is sent as it is.
 * Refuses, with a sentence for the office, anything the route would refuse.
 */
export async function readPickedForUpload(
  file: PickedFile,
  max = MAX_PICKED_UPLOAD_BYTES
): Promise<{ ok: true; upload: ReadyUpload } | { ok: false; error: string }> {
  const problem = pickedUploadProblem(file, max);
  if (problem) return { ok: false, error: problem };
  let base64: string;
  try {
    if (isPickedImage(file) && !isPickedPdf(file)) {
      try {
        base64 = (await prepareImage(file.uri, { base64: true })).base64 ?? "";
      } finally {
        void forget(file.uri);
      }
    } else {
      base64 = await readPickedBase64(file);
    }
  } catch {
    return { ok: false, error: `${file.name} couldn't be read. Try choosing it again.` };
  }
  if (!base64) return { ok: false, error: `${file.name} couldn't be read. Try choosing it again.` };
  const kind = sniffBase64Kind(base64);
  if (!kind) return { ok: false, error: `${file.name} can't be uploaded here — choose a ${UPLOAD_TYPES_HINT}.` };
  const bytes = base64ByteLength(base64);
  if (bytes > max) return { ok: false, error: fileTooBigMessage(file.name, bytes, max) };
  return { ok: true, upload: { originalName: file.name, base64, bytes, kind } };
}

/**
 * Picks ONE file for a PDF-or-photo upload and reads it. Null when cancelled;
 * an error sentence when it can't be used.
 */
export async function pickUploadFile(max = MAX_PICKED_UPLOAD_BYTES): Promise<{ ok: true; upload: ReadyUpload } | { ok: false; error: string } | null> {
  let files: PickedFile[] | null;
  try {
    files = await pickDocuments({ types: UPLOAD_PICKER_TYPES });
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Couldn't open your files." };
  }
  if (!files) return null;
  return readPickedForUpload(files[0], max);
}
