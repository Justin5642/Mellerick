import { describe, it, expect } from "vitest";
import { classifyByName, parseVerdict } from "../../scripts/audit-job-documents.mjs";

// The audit decides which imported job documents technicians stop seeing.
// The failure that matters is a money document classified VISIBLE, so the
// rules must err towards OFFICE/REVIEW, never towards VISIBLE.

describe("classifyByName", () => {
  it.each([
    "simpro-123-PO 4512 Reece.pdf",
    "simpro-9-Purchase_Order.pdf",
    "simpro-9-Tax Invoice 0042.pdf",
    "1700000000_quote-hot-water.pdf",
    "simpro-5-Quotation.docx",
    "receipt.jpg",
    "Statement March.pdf",
    "pricing $ breakdown.pdf",
  ])("flags %s as OFFICE by name", (name) => {
    expect(classifyByName(name, "application/pdf").decision).toBe("OFFICE");
  });

  it("does not mistake Simpro id digits for a PO number", () => {
    expect(classifyByName("simpro-4512-site plans.pdf", "application/pdf")).toEqual({ needs: "pdf" });
  });

  it("does not flag words that merely contain a money word", () => {
    expect(classifyByName("simpro-1-Inspection report.pdf", "application/pdf")).toEqual({ needs: "pdf" });
    expect(classifyByName("simpro-1-Pool layout.pdf", "application/pdf")).toEqual({ needs: "pdf" });
  });

  it("hides spreadsheets and shows CAD drawings", () => {
    expect(classifyByName("simpro-1-takeoff.xlsx", null).decision).toBe("OFFICE");
    expect(classifyByName("simpro-1-ground floor.dwg", null).decision).toBe("VISIBLE");
  });

  it("routes readable files to the AI check and the rest to REVIEW", () => {
    expect(classifyByName("photo.JPG", "image/jpeg")).toEqual({ needs: "image" });
    expect(classifyByName("notes.txt", "text/plain")).toEqual({ needs: "text" });
    expect(classifyByName("scope of works.docx", null).decision).toBe("REVIEW");
  });
});

describe("parseVerdict", () => {
  it("reads both answers", () => {
    expect(parseVerdict("NO_MONEY: hydraulic plan").decision).toBe("VISIBLE");
    expect(parseVerdict("MONEY: supplier invoice with GST total").decision).toBe("OFFICE");
  });

  it("treats anything unclear as REVIEW, never VISIBLE", () => {
    expect(parseVerdict("").decision).toBe("REVIEW");
    expect(parseVerdict("I'm not sure what this is").decision).toBe("REVIEW");
  });
});
