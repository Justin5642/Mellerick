import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  applyPhotoBudget,
  composeDefaultNotes,
  eligiblePhotos,
  groupVisitsByDay,
  latestSignature,
  MAX_REPORT_NOTES_CHARS,
  parseJobReportRequest,
  photoCaptionLine,
  photoExclusion,
  reportNotice,
  selectRequestedPhotos,
  unsupportedPhotoCount,
  chunk,
  type ReportPhotoRow,
} from "@/lib/job-report";

const photo = (over: Partial<ReportPhotoRow> & { id: string }): ReportPhotoRow => ({
  storage_path: `job-1/${over.id}.jpg`,
  caption: null,
  photo_type: "general",
  vendor_order_id: null,
  created_at: "2026-11-03T01:00:00Z",
  ...over,
});

describe("groupVisitsByDay — dates attended, names only", () => {
  const names = { a: "Jake Henderson", b: "Avi Smith", c: "Zed Ng" };

  it("groups work entries by Melbourne day, distinct names A–Z, oldest day first", () => {
    const visits = groupVisitsByDay(
      [
        { staff_id: "c", clock_in: "2026-11-04T22:00:00Z", entry_type: "work" }, // 5 Nov in Melbourne (+11)
        { staff_id: "a", clock_in: "2026-11-03T21:30:00Z", entry_type: "work" }, // 4 Nov
        { staff_id: "b", clock_in: "2026-11-04T02:00:00Z", entry_type: "work" }, // 4 Nov
        { staff_id: "a", clock_in: "2026-11-04T05:00:00Z", entry_type: "work" }, // 4 Nov again
      ],
      names,
    );
    expect(visits.map((v) => v.dateKey)).toEqual(["2026-11-04", "2026-11-05"]);
    expect(visits[0].names).toEqual(["Avi Smith", "Jake Henderson"]);
    expect(visits[1].names).toEqual(["Zed Ng"]);
    expect(visits[0].label).toMatch(/4 Nov 2026/);
  });

  it("ignores travel entries and entries with no clock-in", () => {
    const visits = groupVisitsByDay(
      [
        { staff_id: "a", clock_in: "2026-11-03T21:30:00Z", entry_type: "travel" },
        { staff_id: "a", clock_in: null, entry_type: "work" },
      ],
      names,
    );
    expect(visits).toEqual([]);
  });

  it("keeps a day whose technician has no name, with no names", () => {
    const visits = groupVisitsByDay([{ staff_id: "gone", clock_in: "2026-11-03T21:30:00Z" }], names);
    expect(visits).toHaveLength(1);
    expect(visits[0].names).toEqual([]);
  });

  it("never carries a time or a duration", () => {
    const visits = groupVisitsByDay([{ staff_id: "a", clock_in: "2026-11-03T21:30:00Z", entry_type: "work" }], names);
    expect(Object.keys(visits[0]).sort()).toEqual(["dateKey", "label", "names"]);
    expect(visits[0].label).not.toMatch(/\d{1,2}:\d{2}/);
  });
});

describe("composeDefaultNotes", () => {
  it("stage notes in written order, then the voice report, then completion notes", () => {
    const text = composeDefaultNotes({
      stageNotes: [
        { stage: "fit_off", content: "Fitted toilets.", created_at: "2026-11-06T01:00:00Z" },
        { stage: "drain", content: "  Laid sewer.  ", created_at: "2026-11-03T01:00:00Z" },
        { stage: "test", content: "   ", created_at: "2026-11-07T01:00:00Z" },
      ],
      voiceReportTranscript: "All done and tested.",
      completionNotes: "Left site clean.",
    });
    expect(text).toBe(
      "Drain — 3 Nov 2026\nLaid sewer.\n\nFit Off — 6 Nov 2026\nFitted toilets.\n\nJob report\nAll done and tested.\n\nCompletion notes\nLeft site clean.",
    );
  });

  it("does not repeat completion notes that are the voice report", () => {
    const text = composeDefaultNotes({ stageNotes: [], voiceReportTranscript: "Same.", completionNotes: "Same." });
    expect(text).toBe("Job report\nSame.");
  });

  it("is empty with nothing to say", () => {
    expect(composeDefaultNotes({ stageNotes: [], voiceReportTranscript: null, completionNotes: "" })).toBe("");
  });
});

describe("which photos may go in a report", () => {
  const rows = [
    photo({ id: "late", created_at: "2026-11-05T00:00:00Z" }),
    photo({ id: "early", created_at: "2026-11-01T00:00:00Z", storage_path: "job-1/early.PNG" }),
    photo({ id: "sig", photo_type: "signature", storage_path: "job-1/signature_1.png" }),
    photo({ id: "docket", vendor_order_id: "vo-1" }),
    photo({ id: "heic", storage_path: "job-1/IMG_1.HEIC" }),
    photo({ id: "pdf", storage_path: "job-1/simpro-1-plan.pdf" }),
    photo({ id: "nopath", storage_path: null }),
    photo({ id: "webp", storage_path: "job-1/x.webp", created_at: "2026-11-02T00:00:00Z" }),
  ];

  it("excludes signatures, delivery dockets (may show prices) and unrenderable files", () => {
    expect(photoExclusion(rows[2])).toBe("signature");
    expect(photoExclusion(rows[3])).toBe("docket");
    expect(photoExclusion(rows[4])).toBe("format");
    expect(photoExclusion(rows[5])).toBe("format");
    expect(photoExclusion(rows[6])).toBe("missing");
    expect(eligiblePhotos(rows).map((p) => p.id)).toEqual(["early", "webp", "late"]);
    expect(unsupportedPhotoCount(rows)).toBe(2);
  });

  it("never lets the client add a photo from elsewhere, a docket or a signature", () => {
    const chosen = selectRequestedPhotos(rows, ["late", "docket", "sig", "heic", "other-jobs-photo", "early"]);
    expect(chosen.map((p) => p.id)).toEqual(["early", "late"]);
  });

  it("latestSignature picks the newest signature row", () => {
    const sigs = [
      photo({ id: "s1", photo_type: "signature", created_at: "2026-11-01T00:00:00Z" }),
      photo({ id: "s2", photo_type: "signature", created_at: "2026-11-09T00:00:00Z" }),
      photo({ id: "p", created_at: "2026-11-10T00:00:00Z" }),
    ];
    expect(latestSignature(sigs)?.id).toBe("s2");
    expect(latestSignature([photo({ id: "p" })])).toBeNull();
  });
});

describe("parseJobReportRequest", () => {
  it("accepts the dialog's body and de-duplicates ids", () => {
    const r = parseJobReportRequest({ notes: "a\r\nb", photoIds: ["x", "x", 3, "y"], includeSignature: true });
    expect(r).toEqual({ ok: true, value: { notes: "a\nb", photoIds: ["x", "y"], includeSignature: true } });
  });

  it("leaves the sign-off out unless asked for", () => {
    const r = parseJobReportRequest({ notes: "" });
    expect(r.ok && r.value.includeSignature).toBe(false);
  });

  it("refuses over-long notes and malformed fields", () => {
    expect(parseJobReportRequest({ notes: "x".repeat(MAX_REPORT_NOTES_CHARS + 1) }).ok).toBe(false);
    expect(parseJobReportRequest({ notes: "x".repeat(MAX_REPORT_NOTES_CHARS) }).ok).toBe(true);
    expect(parseJobReportRequest({ notes: 5 }).ok).toBe(false);
    expect(parseJobReportRequest({ photoIds: "x" }).ok).toBe(false);
    expect(parseJobReportRequest(null).ok).toBe(false);
  });
});

describe("applyPhotoBudget — first N that fit", () => {
  it("keeps everything under both caps", () => {
    expect(applyPhotoBudget([10, 20, 30], 40, 100)).toEqual({ kept: [0, 1, 2], omitted: 0 });
  });

  it("stops at the count cap", () => {
    expect(applyPhotoBudget([1, 1, 1, 1], 2, 100)).toEqual({ kept: [0, 1], omitted: 2 });
  });

  it("stops at the first photo that would overflow the bytes, even if a later one is small", () => {
    expect(applyPhotoBudget([40, 50, 30, 5], 40, 100)).toEqual({ kept: [0, 1], omitted: 2 });
  });

  it("skips failed photos without counting them", () => {
    expect(applyPhotoBudget([null, 10, null, 10], 1, 100)).toEqual({ kept: [1], omitted: 1 });
  });
});

describe("reportNotice", () => {
  it("is null when everything went in", () => {
    expect(reportNotice({ omittedForSize: 0, failed: 0, included: 5 })).toBeNull();
  });
  it("names what was left out", () => {
    const n = reportNotice({ omittedForSize: 12, failed: 1, included: 40 })!;
    expect(n).toContain("first 40 photos");
    expect(n).toContain("12 more");
    expect(n).toContain("1 photo could not be read");
  });
});

describe("PDF helpers", () => {
  it("caption line is caption · date, or just the date", () => {
    expect(photoCaptionLine({ caption: " Pit ", created_at: "2026-11-03T01:00:00Z" })).toBe("Pit · 3 Nov 2026");
    expect(photoCaptionLine({ caption: null, created_at: "2026-11-03T01:00:00Z" })).toBe("3 Nov 2026");
  });
  it("chunk makes rows of two", () => {
    expect(chunk([1, 2, 3], 2)).toEqual([[1, 2], [3]]);
  });
});

describe("no hours or money reach the customer report", () => {
  const src = ["lib/job-report-data.ts", "lib/pdf/job-report-template.tsx"].map((f) => readFileSync(f, "utf8")).join("\n");

  it("time entries are read for day and person only", () => {
    const select = src.match(/from\("time_entries"\)\.select\("([^"]+)"/)?.[1];
    expect(select).toBe("id, staff_id, clock_in, entry_type");
  });

  it("no hours, rate or amount column is selected or printed", () => {
    // Code only — the comments explain the rule and so name the words.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(code).not.toMatch(/\b(hours|rate_override|amount|unit_price|total_value|clock_out)\b/);
  });
});
