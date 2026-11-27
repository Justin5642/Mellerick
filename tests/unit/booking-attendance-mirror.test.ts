import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// "Didn't make it" / "Not attended" (27 Nov 2026, 0121): the web board and the
// phone must agree on which bookings are flagged and which weren't attended.
// Only the header comment may differ; the imports must name the same things.
describe("lib/booking-attendance.ts and mobile/lib/bookingAttendance.ts", () => {
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
    expect(body("mobile/lib/bookingAttendance.ts")).toBe(body("lib/booking-attendance.ts"));
  });

  it("import the same lines", () => {
    const imports = (p: string) => read(p).filter((l) => l.startsWith("import "));
    expect(imports("mobile/lib/bookingAttendance.ts")).toEqual(imports("lib/booking-attendance.ts"));
  });
});
