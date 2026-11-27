import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isSentBack, sentBackNotice, sentBackWhen } from "@/lib/sent-back";

describe("sent-back rule (0122)", () => {
  it("shows while the office has sent the job back and it is open", () => {
    expect(isSentBack({ status: "in_progress", admin_status: "rejected" })).toBe(true);
    expect(isSentBack({ status: "pending", admin_status: "rejected" })).toBe(true);
  });

  it("clears when signed off again, approved or closed", () => {
    expect(isSentBack({ status: "completed", admin_status: "pending" })).toBe(false);
    expect(isSentBack({ status: "in_progress", admin_status: "approved" })).toBe(false);
    expect(isSentBack({ status: "completed", admin_status: "rejected" })).toBe(false);
    expect(isSentBack({ status: "cancelled", admin_status: "rejected" })).toBe(false);
    expect(isSentBack(null)).toBe(false);
    // Phone mirror before the stream redeploy: the column isn't there.
    expect(isSentBack({ status: "in_progress" })).toBe(false);
  });

  it("uses the stamped note, else (web, before 0122) admin_notes", () => {
    expect(
      sentBackNotice({ status: "in_progress", admin_status: "rejected", sent_back_note: " Need CCTV ", sent_back_at: "2026-11-27T03:15:00Z", admin_notes: "x" }),
    ).toEqual({ note: "Need CCTV", at: "2026-11-27T03:15:00Z" });
    expect(sentBackNotice({ status: "in_progress", admin_status: "rejected", admin_notes: "Photos please" })).toEqual({
      note: "Photos please",
      at: null,
    });
    expect(sentBackNotice({ status: "in_progress", admin_status: "rejected", sent_back_note: "  " })).toEqual({ note: null, at: null });
    expect(sentBackNotice({ status: "completed", admin_status: "pending", sent_back_note: "old" })).toBeNull();
  });

  it("says when in Melbourne time", () => {
    expect(sentBackWhen("2026-11-27T03:15:00Z")).toBe("Fri 27 Nov, 2:15 pm");
    expect(sentBackWhen(null)).toBeNull();
    expect(sentBackWhen("not a date")).toBeNull();
  });
});

describe("lib/sent-back.ts and mobile/lib/sentBack.ts", () => {
  const fromFirstExport = (p: string) => {
    const lines = readFileSync(join(process.cwd(), p), "utf8").split("\n");
    const first = lines.findIndex((l) => l.startsWith("export "));
    expect(first).toBeGreaterThan(-1);
    return lines.slice(first).join("\n");
  };

  it("are identical from the first export on", () => {
    expect(fromFirstExport("mobile/lib/sentBack.ts")).toBe(fromFirstExport("lib/sent-back.ts"));
  });
});
