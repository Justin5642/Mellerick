import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Actual clocked time on the schedule (27 Nov 2026): the web board and the
// phone's office Schedule tab must split, match and label clocked time the
// same way. Only the header comment and the import paths may differ.
describe("lib/schedule-actuals.ts and mobile/lib/scheduleActuals.ts", () => {
  const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8").split("\n");
  const body = (p: string) => {
    const lines = read(p);
    let lastImport = -1;
    lines.forEach((line, i) => {
      if (line.startsWith("import ")) lastImport = i;
    });
    expect(lastImport).toBeGreaterThan(-1);
    return lines.slice(lastImport + 1).join("\n");
  };

  it("are identical below the imports", () => {
    expect(body("mobile/lib/scheduleActuals.ts")).toBe(body("lib/schedule-actuals.ts"));
  });

  it("import the same names", () => {
    const names = (p: string) =>
      read(p)
        .filter((l) => l.startsWith("import "))
        .map((l) => l.replace(/from ".*"/, ""));
    expect(names("mobile/lib/scheduleActuals.ts")).toEqual(names("lib/schedule-actuals.ts"));
  });

  it("never names a money column", () => {
    expect(body("lib/schedule-actuals.ts")).not.toMatch(/rate_override|amount|price|\bcost\b/i);
  });
});
