import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { clockPlace } from "@/lib/clock-location";

// The phone's Time tab shows the same "On site" / "320 m from site" flag as the
// web (0092). The rule lives in lib/clock-location.ts and is copied to
// mobile/lib/clockLocation.ts (no shared imports between the two packages).
// Everything from the first doc comment down must be identical.

function body(rel: string): string {
  const src = readFileSync(join(process.cwd(), rel), "utf8").replace(/\r\n/g, "\n");
  const start = src.indexOf("/** The standard site fence");
  expect(start).toBeGreaterThanOrEqual(0);
  return src.slice(start);
}

describe("lib/clock-location.ts and mobile/lib/clockLocation.ts", () => {
  it("are identical below the header", () => {
    expect(body("mobile/lib/clockLocation.ts")).toBe(body("lib/clock-location.ts"));
  });

  it("flags a clock-on outside the fence even allowing for accuracy", () => {
    const site = { lat: -37.8, lng: 145.0 };
    // ~330 m north.
    expect(clockPlace({ lat: -37.797, lng: 145.0, accuracy: 20 }, site)).toMatchObject({ outside: true, label: "334 m from site" });
    // Same place, but the phone said ±300 m — not provably outside.
    expect(clockPlace({ lat: -37.797, lng: 145.0, accuracy: 300 }, site)?.outside).toBe(false);
    expect(clockPlace({ lat: -37.8, lng: 145.0 }, site)?.label).toBe("on site");
    expect(clockPlace({ lat: null, lng: null }, site)).toBeNull();
    expect(clockPlace({ lat: -37.8, lng: 145.0 }, { lat: 0, lng: 0 })).toBeNull();
  });
});
