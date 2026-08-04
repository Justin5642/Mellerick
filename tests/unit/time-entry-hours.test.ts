import { describe, it, expect } from "vitest";
import { plausibleClockedHours, MAX_PLAUSIBLE_WORK_HOURS } from "@/lib/time-entry-hours";

// The web clock-out did the raw subtraction and wrote the result straight to
// time_entries.hours, with no plausibility check — the same defect fixed in the
// mobile geofence, in two more places nobody had looked at.
//
// The scenario that makes this more than theoretical is CROSS-DEVICE. A
// technician clocks in on the mobile app whose device clock runs fast; the
// office clocks them out from the web with a correct clock. clock_out then
// precedes clock_in, the subtraction goes negative, and a negative number is
// written to the entry that feeds payroll. Nothing raises. It simply reconciles
// wrong at the next pay run.
//
// hours is nullable in production (verified against the live schema), so an
// implausible duration is recorded as null: the entry still closes, and the
// office sees a gap to correct rather than a figure that looks legitimate.

const iso = (ms: number) => new Date(ms).toISOString();
const T0 = Date.parse("2026-08-03T08:00:00.000Z");
const H = 3600000;

describe("plausibleClockedHours", () => {
  it("returns rounded hours for an ordinary shift", () => {
    expect(plausibleClockedHours(iso(T0), iso(T0 + 7.5 * H))).toBe(7.5);
  });

  it("rounds to two decimals, matching what the entry previously stored", () => {
    expect(plausibleClockedHours(iso(T0), iso(T0 + 1_000_000))).toBe(0.28);
  });

  // THE DEFECT. Cross-device clock skew, or a browser clock correcting itself.
  it("returns null when clock_out precedes clock_in", () => {
    expect(plausibleClockedHours(iso(T0), iso(T0 - H))).toBeNull();
  });

  it("returns null for a zero-length entry", () => {
    expect(plausibleClockedHours(iso(T0), iso(T0))).toBeNull();
  });

  it("returns null for a shift longer than a person plausibly works", () => {
    // An entry left open overnight, or over a weekend, then closed.
    expect(plausibleClockedHours(iso(T0), iso(T0 + 30 * H))).toBeNull();
  });

  it("accepts a long but real shift at the boundary", () => {
    expect(plausibleClockedHours(iso(T0), iso(T0 + MAX_PLAUSIBLE_WORK_HOURS * H))).toBe(
      MAX_PLAUSIBLE_WORK_HOURS
    );
  });

  it("returns null for an unparseable timestamp rather than NaN", () => {
    expect(plausibleClockedHours("not-a-date", iso(T0))).toBeNull();
    expect(plausibleClockedHours(iso(T0), "not-a-date")).toBeNull();
  });

  it("uses the same ceiling as the mobile auto-clock, so the platforms agree", () => {
    // mobile/lib/autoClockHours.ts uses 16. A technician clocking in on the
    // phone and out on the web must not get a different verdict on the same
    // duration.
    expect(MAX_PLAUSIBLE_WORK_HOURS).toBe(16);
  });
});
