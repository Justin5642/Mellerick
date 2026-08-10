import fs from "fs";
import path from "path";

// The business logo, read from disk once per process.
//
// This was duplicated byte-for-byte in lib/pdf/render.ts and
// lib/pdf/render-backflow.ts — including the cache variable, so the two
// renderers each held their own copy of the same file. Harmless, but two
// definitions of "where the logo lives" is one more than there should be, and
// the next renderer would have made three.
//
// `undefined` means not yet attempted; `null` means attempted and failed. The
// distinction is what makes the cache work — without it a missing file is
// re-read on every render, and a PDF renderer is not somewhere to add
// per-invocation filesystem calls.
let cachedLogo: { data: Buffer; format: "png" } | null | undefined;

export function loadLogo(): { data: Buffer; format: "png" } | null {
  if (cachedLogo !== undefined) return cachedLogo;
  try {
    const logoPath = path.join(process.cwd(), "public", "logo.png");
    cachedLogo = { data: fs.readFileSync(logoPath), format: "png" };
  } catch {
    // A missing logo must not stop an invoice rendering. The template already
    // handles null by leaving the header text-only.
    cachedLogo = null;
  }
  return cachedLogo;
}
