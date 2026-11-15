import { describe, it, expect } from "vitest";
import { pinFromClockOns, type ClockOnReading } from "@/lib/site-pin-from-clock";

// A wrong pin is worse than none: it clocks the crew onto the job wherever it
// landed. These are the rules that keep a yard or roadside clock-on out.

const LOT = { lat: -37.4855, lng: 144.9902 }; // Beveridge
const YARD = { lat: -37.6545, lng: 145.0158 }; // ~19 km south
const STREET = { lat: -37.4862, lng: 144.9915 }; // street centre, ~140 m off

const at = (p: { lat: number; lng: number }, over: Partial<ClockOnReading> = {}): ClockOnReading => ({
  staffId: "brodie",
  clockIn: "2026-11-03T07:02:00Z",
  lat: p.lat,
  lng: p.lng,
  accuracy: 12,
  ...over,
});

describe("pinFromClockOns", () => {
  it("pins an accurate clock-on near the street the geocoder found", () => {
    expect(pinFromClockOns([at(LOT)], STREET)).toEqual({ ...LOT, staffId: "brodie" });
  });

  it("ignores a clock-on far from that street (the yard)", () => {
    expect(pinFromClockOns([at(YARD)], STREET)).toBeNull();
  });

  it("ignores an inaccurate or missing reading", () => {
    expect(pinFromClockOns([at(LOT, { accuracy: 65 })], STREET)).toBeNull();
    expect(pinFromClockOns([at(LOT, { accuracy: null })], STREET)).toBeNull();
    expect(pinFromClockOns([at({ lat: 0, lng: 0 })], null)).toBeNull();
  });

  it("takes the most accurate of several", () => {
    const close = { lat: LOT.lat + 0.0002, lng: LOT.lng };
    expect(pinFromClockOns([at(close, { accuracy: 40 }), at(LOT, { accuracy: 6, staffId: "declan" })], STREET)).toEqual({ ...LOT, staffId: "declan" });
  });

  describe("when the geocoder can't find even the street", () => {
    it("one clock-on is not enough", () => {
      expect(pinFromClockOns([at(LOT)], null)).toBeNull();
    });

    it("two from different days or people that agree are", () => {
      const near = { lat: LOT.lat + 0.0003, lng: LOT.lng }; // ~33 m
      expect(pinFromClockOns([at(LOT), at(near, { clockIn: "2026-11-04T07:00:00Z" })], null)).not.toBeNull();
      expect(pinFromClockOns([at(LOT), at(near, { staffId: "declan" })], null)).not.toBeNull();
    });

    it("but not the same person twice on the same day, or two that disagree", () => {
      expect(pinFromClockOns([at(LOT), at(LOT, { clockIn: "2026-11-03T12:30:00Z" })], null)).toBeNull();
      expect(pinFromClockOns([at(LOT), at(YARD, { staffId: "declan" })], null)).toBeNull();
    });
  });
});
