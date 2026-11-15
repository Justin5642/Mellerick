import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// The phone's schedule grid places bookings with a copy of the web board's
// pure model. Both must agree on which cell a booking lands in, how many hours
// a technician is booked and what a move changes, or the office sees one
// schedule on the website and another on the phone. Only the header comment
// and the import lines may differ (the paths differ by platform).
describe("components/schedule/board-model.ts and mobile/lib/boardModel.ts", () => {
  it("are identical below the imports", () => {
    const body = (p: string) => {
      const lines = readFileSync(join(process.cwd(), p), "utf8").split("\n");
      let lastImport = -1;
      lines.forEach((line, i) => {
        if (line.startsWith("import ")) lastImport = i;
      });
      expect(lastImport).toBeGreaterThan(-1);
      return lines.slice(lastImport + 1).join("\n");
    };
    expect(body("mobile/lib/boardModel.ts")).toBe(body("components/schedule/board-model.ts"));
  });

  it("import the same names", () => {
    const names = (p: string) =>
      readFileSync(join(process.cwd(), p), "utf8")
        .split("\n")
        .filter((l) => l.startsWith("import "))
        .flatMap((l) => l.replace(/^import \{(.*)\} from .*$/, "$1").split(","))
        .map((n) => n.trim().replace(/^type /, "").replace(/^\w+ as /, ""))
        .sort();
    expect(names("mobile/lib/boardModel.ts")).toEqual(names("components/schedule/board-model.ts"));
  });
});
