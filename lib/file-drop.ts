// Pure rules behind components/ui/file-drop-zone.tsx (drag-and-drop and
// paste onto a whole tab — the job's Photos and Documents tabs). No DOM types
// beyond the plain shapes below, so they are tested in tests/unit/file-drop.test.ts.

import { fileMatchesAccept } from "@/lib/file-accept";

export interface NamedFile {
  name: string;
  type: string;
  size: number;
}

/**
 * Does a drag carry files? A drag of text, a link or something on the page
 * itself (a card on the schedule board) has no "Files" type and must not light
 * the drop zone up. Chrome and Safari list "Files" for an image dragged from
 * another tab when they will hand over the file; Firefox lists
 * "application/x-moz-file" too.
 */
export function dragHasFiles(types: readonly string[] | null | undefined): boolean {
  if (!types) return false;
  return Array.from(types).some((t) => t === "Files" || t === "application/x-moz-file");
}

/**
 * Splits dropped/pasted files into those the tab's upload accepts (the same
 * `accept` string as its file input — the browser enforces it for the picker
 * but not for a drop or a paste) and those it refuses. Folders dropped by
 * mistake arrive as empty, typeless entries and are refused too.
 */
export function splitAcceptedFiles<T extends NamedFile>(files: readonly T[], accept?: string): { accepted: T[]; rejected: T[] } {
  const accepted: T[] = [];
  const rejected: T[] = [];
  for (const f of files) {
    const looksLikeFolder = f.size === 0 && !f.type && !/\.[a-z0-9]{1,8}$/i.test(f.name);
    if (!looksLikeFolder && fileMatchesAccept(f, accept)) accepted.push(f);
    else rejected.push(f);
  }
  return { accepted, rejected };
}

/** "notes.txt isn't a supported file type (PDF, Word, …)" / "3 files aren't …". */
export function rejectionMessage(rejected: readonly NamedFile[], hint?: string): string | null {
  if (rejected.length === 0) return null;
  const tail = hint ? ` — ${hint}` : "";
  if (rejected.length === 1) return `${rejected[0].name || "That file"} isn't a supported file type${tail}`;
  const names = rejected.slice(0, 3).map((f) => f.name || "unnamed").join(", ");
  const more = rejected.length > 3 ? ` and ${rejected.length - 3} more` : "";
  return `${rejected.length} files aren't a supported file type (${names}${more})${tail}`;
}

const EXT_BY_TYPE: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/heic": "heic",
  "image/bmp": "bmp",
  "application/pdf": "pdf",
};

function stamp(now: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
}

/**
 * A screenshot pasted from the clipboard is always called "image.png" (or has
 * no name at all), so several pastes would all look alike in the list. Gives
 * such files a dated name; a real file name (copied in Explorer/Finder) is kept.
 */
export function pastedFileName(file: { name?: string | null; type: string }, now: Date, index = 0): string {
  const name = (file.name ?? "").trim();
  const generic = !name || /^image\.(png|jpe?g|gif|webp|bmp)$/i.test(name) || name === "blob";
  if (!generic) return name;
  const ext = EXT_BY_TYPE[file.type.toLowerCase()] ?? (file.type.startsWith("image/") ? file.type.slice(6).replace(/[^a-z0-9]/gi, "") || "png" : "bin");
  return `pasted-${stamp(now)}${index ? `-${index + 1}` : ""}.${ext}`;
}

/**
 * Should a paste on the page become an upload? Not while the user is typing
 * into a field (a note, a search box) — that paste belongs to the field.
 */
export function pasteTargetIsEditable(target: { tagName?: string; isContentEditable?: boolean; type?: string } | null | undefined): boolean {
  if (!target) return false;
  if (target.isContentEditable) return true;
  const tag = (target.tagName ?? "").toUpperCase();
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag === "INPUT") {
    const type = (target.type ?? "text").toLowerCase();
    return !["button", "checkbox", "radio", "file", "submit", "reset", "range", "color", "image"].includes(type);
  }
  return false;
}

/**
 * An image dragged from a page that hands over no File (e.g. some webmail
 * previews) still carries its address. Only inline `data:` images can be
 * turned into a file in the browser — anything on another site is blocked by
 * that site (CORS), so the user is told to save it first. Returns the data
 * URLs found in a text/uri-list or text/html payload, in order, no repeats.
 */
export function inlineImageUrls(uriList: string | null | undefined, html: string | null | undefined): string[] {
  const found: string[] = [];
  const add = (u: string) => {
    const url = u.trim();
    if (/^data:image\/[a-z0-9.+-]+;base64,/i.test(url) && !found.includes(url)) found.push(url);
  };
  for (const line of (uriList ?? "").split(/\r?\n/)) if (line && !line.startsWith("#")) add(line);
  for (const m of (html ?? "").matchAll(/<img[^>]+src\s*=\s*["']([^"']+)["']/gi)) add(m[1]);
  return found;
}

/** Was something other than a file dropped (a link or a web image we can't fetch)? */
export function droppedOnlyALink(uriList: string | null | undefined, html: string | null | undefined): boolean {
  const hasLink = (uriList ?? "").split(/\r?\n/).some((l) => /^https?:\/\//i.test(l.trim()));
  const hasImg = /<img[^>]+src\s*=\s*["']https?:/i.test(html ?? "");
  return hasLink || hasImg;
}
