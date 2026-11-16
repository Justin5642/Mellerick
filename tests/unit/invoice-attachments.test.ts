import { describe, it, expect } from "vitest";
import {
  MAX_ATTACHMENTS,
  MAX_ATTACHMENT_TOTAL_BYTES,
  base64Bytes,
  cleanAttachmentName,
  parseExtraAttachments,
} from "@/lib/invoice-attachments";

const b64 = (n: number) => Buffer.alloc(n, 1).toString("base64");

describe("invoice attachments", () => {
  it("measures decoded size", () => {
    for (const n of [0, 1, 2, 3, 1000]) expect(base64Bytes(b64(n))).toBe(n);
  });

  it("cleans names: no folders, no control characters, kept short with the extension", () => {
    expect(cleanAttachmentName("C:\\\\Users\\\\x\\\\plan.pdf")).toBe("plan.pdf");
    expect(cleanAttachmentName("../a\u0000b.pdf")).toBe("ab.pdf");
    const long = cleanAttachmentName("x".repeat(300) + ".pdf");
    expect(long.length).toBe(120);
    expect(long.endsWith(".pdf")).toBe(true);
  });

  it("no attachments is fine", () => {
    expect(parseExtraAttachments(undefined)).toEqual({ ok: true, value: [] });
  });

  it("refuses too many, too big in total, and non-arrays", () => {
    const one = { filename: "a.pdf", content: b64(10) };
    expect(parseExtraAttachments(Array(MAX_ATTACHMENTS + 1).fill(one)).ok).toBe(false);
    expect(parseExtraAttachments({}).ok).toBe(false);
    const half = { filename: "a.pdf", content: b64(MAX_ATTACHMENT_TOTAL_BYTES / 2 + 3) };
    const r = parseExtraAttachments([half, half]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("Nothing was sent");
  });

  it("numbers duplicate names", () => {
    const r = parseExtraAttachments(
      [{ filename: "a.pdf", content: b64(3) }, { filename: "A.pdf", content: b64(3) }],
      ["invoice-1.pdf"],
    );
    expect(r).toEqual({ ok: true, value: [{ filename: "a.pdf", content: b64(3) }, { filename: "A (2).pdf", content: b64(3) }] });
  });
});
