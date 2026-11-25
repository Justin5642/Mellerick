import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { scheduleBlockTones } from "@/lib/schedule-block-tones";
import { statusColors } from "../../mobile/lib/theme";

// The web board draws the phone's schedule layout (25 Nov 2026 — Justin: "We
// prefer the mobile app's schedule"). Both must place a booking's block at
// the same time, in the same lane, or the two schedules stop looking alike.
// Only the header comment and the import lines may differ.
describe("lib/schedule-grid.ts and mobile/lib/scheduleGrid.ts", () => {
  const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8").split("\n");

  it("are identical below the imports", () => {
    const body = (p: string) => {
      const lines = read(p);
      let lastImport = -1;
      lines.forEach((line, i) => {
        if (line.startsWith("import ")) lastImport = i;
      });
      expect(lastImport).toBeGreaterThan(-1);
      return lines.slice(lastImport + 1).join("\n");
    };
    expect(body("mobile/lib/scheduleGrid.ts")).toBe(body("lib/schedule-grid.ts"));
  });

  it("import the same names", () => {
    const names = (p: string) =>
      read(p)
        .filter((l) => l.startsWith("import "))
        .flatMap((l) => l.replace(/^import (type )?\{(.*)\} from .*$/, "$2").split(","))
        .map((n) => n.trim().replace(/^type /, "").replace(/^\w+ as /, ""))
        .sort();
    expect(names("mobile/lib/scheduleGrid.ts")).toEqual(names("lib/schedule-grid.ts"));
  });
});

describe("schedule block colours", () => {
  it("are the phone's status colours (mobile/lib/theme.ts statusColors)", () => {
    expect(scheduleBlockTones).toEqual(statusColors);
  });
});
