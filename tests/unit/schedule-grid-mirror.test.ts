import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { scheduleBlockTones } from "@/lib/schedule-block-tones";

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
  // Read as text: importing mobile/lib/theme.ts from the web suite pulls in the
  // phone's tsconfig (expo), which CI's web job doesn't install.
  it("are the phone's status colours (mobile/lib/theme.ts statusColors)", () => {
    const theme = readFileSync(join(process.cwd(), "mobile/lib/theme.ts"), "utf8");
    const hex = (name: string) => {
      const m = theme.match(new RegExp(`\\b${name}:\\s*"(#[0-9a-fA-F]{6})"`));
      if (!m) throw new Error(`colour ${name} not found in mobile/lib/theme.ts`);
      return m[1].toLowerCase();
    };
    const block = theme.slice(theme.indexOf("export const statusColors"));
    const body = block.slice(0, block.indexOf("};"));
    const phone: Record<string, { bg: string; text: string }> = {};
    for (const m of body.matchAll(/(\w+):\s*\{\s*bg:\s*colors\.(\w+),\s*text:\s*colors\.(\w+)\s*\}/g)) {
      phone[m[1]] = { bg: hex(m[2]), text: hex(m[3]) };
    }
    expect(Object.keys(phone).length).toBeGreaterThan(0);
    expect(scheduleBlockTones).toEqual(phone);
  });
});
