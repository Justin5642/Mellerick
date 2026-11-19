import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// The phone checks and defaults a booking's cost centre with a copy of the
// web's rules (19 Nov 2026). Only the header comment may differ.
const fromFirstExport = (p: string) => {
  const lines = readFileSync(join(process.cwd(), p), "utf8").split("\n");
  const first = lines.findIndex((l) => l.startsWith("export "));
  expect(first).toBeGreaterThan(-1);
  expect(lines.some((l) => l.startsWith("import "))).toBe(false);
  return lines.slice(first).join("\n");
};

describe("lib/booking-cost-centre.ts and mobile/lib/bookingCostCentre.ts", () => {
  it("are identical from the first export on", () => {
    expect(fromFirstExport("mobile/lib/bookingCostCentre.ts")).toBe(fromFirstExport("lib/booking-cost-centre.ts"));
  });
});
