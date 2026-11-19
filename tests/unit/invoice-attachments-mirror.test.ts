import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MAX_REPORT_NOTES_CHARS, MAX_REPORT_PHOTOS } from "@/lib/job-report";

// The phone's Send Invoice screen (mobile/app/invoices/[id]/send.tsx) checks
// attachments with a copy of lib/invoice-attachments.ts and the job report
// with copies of its two limits. The server is the authority; these pin the
// copies so the phone never accepts what the server would refuse, or the
// other way round.

/** The file without its leading doc comment (each copy has its own). */
const body = (f: string) => {
  const src = readFileSync(f, "utf8");
  return src.slice(src.indexOf("*/") + 2);
};

describe("mobile/lib/invoiceAttachments.ts", () => {
  it("is byte-identical to lib/invoice-attachments.ts below the header", () => {
    expect(body("mobile/lib/invoiceAttachments.ts")).toBe(body("lib/invoice-attachments.ts"));
  });
});

describe("mobile/lib/invoiceSend.ts job report limits", () => {
  const src = readFileSync("mobile/lib/invoiceSend.ts", "utf8");
  const constant = (name: string) => {
    const m = src.match(new RegExp(`export const ${name} = ([0-9_]+);`));
    return m ? Number(m[1].replace(/_/g, "")) : null;
  };
  it("match lib/job-report.ts", () => {
    expect(constant("MAX_REPORT_NOTES_CHARS")).toBe(MAX_REPORT_NOTES_CHARS);
    expect(constant("MAX_REPORT_PHOTOS")).toBe(MAX_REPORT_PHOTOS);
  });
});
