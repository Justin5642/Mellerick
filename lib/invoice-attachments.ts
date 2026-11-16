/**
 * Extra files the office drops onto the Send Invoice dialog (16 Nov 2026):
 * a builder's form, a test certificate, site photos taken on someone's own
 * phone. They ride on the invoice email next to the invoice PDF (and the job
 * report, when ticked). Not stored anywhere — the email is the record.
 *
 * They travel inside the send request as base64, so the total has to stay
 * under Vercel's 4.5 MB request-body limit: base64 is 4/3 the size, so
 * 3 MB of files is ~4 MB of body. Photos are shrunk in the browser first
 * (lib/image-resize.ts), which leaves the limit for PDFs.
 */

export const MAX_ATTACHMENTS = 10;
export const MAX_ATTACHMENT_TOTAL_BYTES = 3 * 1024 * 1024;

/** Same format as <input accept>. */
export const ATTACHMENT_ACCEPT =
  ".pdf,.jpg,.jpeg,.png,.webp,.heic,.doc,.docx,.xls,.xlsx,.csv,.txt," +
  "application/pdf,image/jpeg,image/png,image/webp,image/heic";
export const ATTACHMENT_HINT = "PDF, photos, Word or Excel — up to 3 MB in total";

const EXTENSIONS = ATTACHMENT_ACCEPT.split(",").filter((s) => s.startsWith("."));

export type ExtraAttachment = { filename: string; content: string };

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** A file name safe for an email attachment: no folders, no control characters. */
export function cleanAttachmentName(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? "";
  const clean = base.replace(/[\u0000-\u001f\u007f"<>|*?:]/g, "").trim();
  if (clean.length <= 120) return clean;
  const dot = clean.lastIndexOf(".");
  const ext = dot > 0 && clean.length - dot <= 6 ? clean.slice(dot) : "";
  return clean.slice(0, 120 - ext.length) + ext;
}

/** Size in bytes of what a base64 string decodes to. */
export function base64Bytes(b64: string): number {
  const pad = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  return Math.floor((b64.length * 3) / 4) - pad;
}

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/**
 * Checks `attachments` from the send request. Anything wrong refuses the
 * whole send — the office sees why and nothing reaches the customer half-done.
 * `reserved` are names already taken by the invoice PDF and job report.
 */
export function parseExtraAttachments(
  raw: unknown,
  reserved: string[] = [],
): { ok: true; value: ExtraAttachment[] } | { ok: false; error: string } {
  if (raw == null) return { ok: true, value: [] };
  if (!Array.isArray(raw)) return { ok: false, error: "The attached files could not be read. Nothing was sent." };
  if (raw.length > MAX_ATTACHMENTS) {
    return { ok: false, error: `Attach at most ${MAX_ATTACHMENTS} files. Nothing was sent.` };
  }
  const taken = new Set(reserved.map((n) => n.toLowerCase()));
  const out: ExtraAttachment[] = [];
  let total = 0;
  for (const item of raw) {
    const name = cleanAttachmentName(typeof item?.filename === "string" ? item.filename : "");
    const content = typeof item?.content === "string" ? item.content : "";
    if (!name || !content || content.length % 4 !== 0 || !BASE64.test(content)) {
      return { ok: false, error: "One of the attached files could not be read. Nothing was sent." };
    }
    const lower = name.toLowerCase();
    if (!EXTENSIONS.some((ext) => lower.endsWith(ext))) {
      return { ok: false, error: `${name} isn't a file type that can be attached (${ATTACHMENT_HINT}). Nothing was sent.` };
    }
    total += base64Bytes(content);
    if (total > MAX_ATTACHMENT_TOTAL_BYTES) {
      return {
        ok: false,
        error: `The attached files are over ${formatBytes(MAX_ATTACHMENT_TOTAL_BYTES)} in total. Remove one and try again. Nothing was sent.`,
      };
    }
    // Two files with one name would arrive as one in some mail apps.
    let unique = name;
    for (let i = 2; taken.has(unique.toLowerCase()); i++) {
      const dot = name.lastIndexOf(".");
      unique = dot > 0 ? `${name.slice(0, dot)} (${i})${name.slice(dot)}` : `${name} (${i})`;
    }
    taken.add(unique.toLowerCase());
    out.push({ filename: unique, content });
  }
  return { ok: true, value: out };
}
