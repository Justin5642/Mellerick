import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Time against variations (0120): the web Time tab, the ledger and the phone's
// clock-on picker must agree on which time is variation time and which counts
// toward a stage's allowed hours. One rule, read as text (the web unit job has
// no mobile node_modules, so the phone file is never imported here).
const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8").split("\n");

describe("lib/variation-time.ts and mobile/lib/variationTime.ts", () => {
  it("are identical from the first export on, with no imports", () => {
    const fromFirstExport = (p: string) => {
      const lines = read(p);
      const first = lines.findIndex((l) => l.startsWith("export "));
      expect(first).toBeGreaterThan(-1);
      expect(lines.some((l) => l.startsWith("import "))).toBe(false);
      return lines.slice(first).join("\n");
    };
    expect(fromFirstExport("mobile/lib/variationTime.ts")).toBe(fromFirstExport("lib/variation-time.ts"));
  });

  it("carry no money words", () => {
    for (const p of ["lib/variation-time.ts", "mobile/lib/variationTime.ts"]) {
      const code = read(p)
        .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
        .join("\n");
      expect(code).not.toMatch(/\b(rate|amount|price|total_amount|cost)\b/i);
      // A dollar figure would start a string with "$" followed by a digit or an amount.
      expect(code).not.toMatch(/["'`]\$\s*\d|\$\$/);
    }
  });
});
