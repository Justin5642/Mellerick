import { describe, it, expect } from "vitest";
import { fileMatchesAccept } from "@/lib/file-accept";

const f = (name: string, type: string) => ({ name, type });

describe("fileMatchesAccept", () => {
  it("allows anything when accept is empty", () => {
    expect(fileMatchesAccept(f("x.exe", "application/octet-stream"))).toBe(true);
    expect(fileMatchesAccept(f("x.exe", ""), "  ")).toBe(true);
  });

  it("matches extensions case-insensitively", () => {
    expect(fileMatchesAccept(f("Receipt.PDF", "application/pdf"), ".pdf,.png,.jpg,.jpeg")).toBe(true);
    expect(fileMatchesAccept(f("photo.JPEG", ""), ".pdf,.png,.jpg,.jpeg")).toBe(true);
    expect(fileMatchesAccept(f("notes.docx", "application/vnd.openxmlformats"), ".pdf,.png,.jpg,.jpeg")).toBe(false);
  });

  it("matches exact and wildcard MIME types", () => {
    expect(fileMatchesAccept(f("inv.pdf", "application/pdf"), "application/pdf,image/*")).toBe(true);
    expect(fileMatchesAccept(f("scan.heic", "image/heic"), "application/pdf,image/*")).toBe(true);
    expect(fileMatchesAccept(f("data.csv", "text/csv"), "application/pdf,image/*")).toBe(false);
  });
});
