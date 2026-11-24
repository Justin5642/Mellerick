import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// The web schedule board and the phone's office Schedule tab both flag
// bookings on jobs over their allowed hours (Justin, 24 Nov 2026: "the 2
// schedules not aligned"). One rule, so the two never disagree about which
// jobs are over. Only the header comment may differ.
const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8").split("\n");

describe("lib/over-hours.ts and mobile/lib/overHours.ts", () => {
  it("are identical from the first export on, with no imports", () => {
    const fromFirstExport = (p: string) => {
      const lines = read(p);
      const first = lines.findIndex((l) => l.startsWith("export "));
      expect(first).toBeGreaterThan(-1);
      expect(lines.some((l) => l.startsWith("import "))).toBe(false);
      return lines.slice(first).join("\n");
    };
    expect(fromFirstExport("mobile/lib/overHours.ts")).toBe(fromFirstExport("lib/over-hours.ts"));
  });
});
