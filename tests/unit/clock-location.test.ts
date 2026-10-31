import { describe, it, expect } from "vitest";
import { clockPlace } from "@/lib/clock-location";

// Where a clock-on/off was, for the office (0092). A flag, never a block.
const SITE = { lat: -37.8136, lng: 144.9631 };

describe("clockPlace", () => {
  it("calls a fix on the pin 'on site'", () => {
    expect(clockPlace({ lat: SITE.lat, lng: SITE.lng, accuracy: 10 }, SITE)).toMatchObject({ outside: false, label: "on site" });
  });

  it("flags a clock-on well outside the fence", () => {
    const p = clockPlace({ lat: -37.8236, lng: 144.9631, accuracy: 20 }, SITE); // ~1.1 km
    expect(p?.outside).toBe(true);
    expect(p?.label).toMatch(/km from site/);
  });

  it("gives the benefit of the doubt when the phone's accuracy covers the gap", () => {
    // ~200 m away, ±80 m: could have been inside 150 m.
    expect(clockPlace({ lat: SITE.lat - 0.0018, lng: SITE.lng, accuracy: 80 }, SITE)?.outside).toBe(false);
  });

  it("says nothing with no fix or no site pin", () => {
    expect(clockPlace({ lat: null, lng: null }, SITE)).toBeNull();
    expect(clockPlace({ lat: SITE.lat, lng: SITE.lng }, null)).toBeNull();
    expect(clockPlace({ lat: SITE.lat, lng: SITE.lng }, { lat: 0, lng: 0 })).toBeNull();
  });
});
