import { describe, it, expect } from "vitest";
import {
  splitHoursByBand,
  applyRateOverride,
  computeLabourCharge,
  DEFAULT_LABOUR_RATE_CONFIG,
  type HourBreakdown,
} from "@/lib/labour-billing";

// Characterization tests for the labour pricing engine. Band boundaries are
// Melbourne wall-clock (Australia/Melbourne). July = AEST (UTC+10), no DST,
// so a Melbourne HH:00 is (HH-10):00 UTC — the ISO instants below encode that
// explicitly. Weekday bands (confirmed with business, see lib/labour-billing.ts):
//   00:00-05:00 double | 05:00-07:00 time-and-half | 07:00-17:00 ordinary
//   17:00-19:00 time-and-half | 19:00-24:00 double. Sat/Sun = all double.
// 2026-07-06 is a Monday; 2026-07-11 is a Saturday.

// Melbourne local time -> UTC ISO instant (AEST, UTC+10, July has no DST).
function mel(dateKey: string, hour: number, min = 0): string {
  const utcHour = hour - 10;
  return new Date(Date.UTC(
    Number(dateKey.slice(0, 4)),
    Number(dateKey.slice(5, 7)) - 1,
    Number(dateKey.slice(8, 10)),
    utcHour, min,
  )).toISOString();
}

describe("splitHoursByBand", () => {
  it("prices a full 07:00-17:00 weekday shift as all ordinary hours", () => {
    const b = splitHoursByBand(mel("2026-07-06", 7), mel("2026-07-06", 17));
    expect(b.normalHours).toBeCloseTo(10, 6);
    expect(b.timeAndHalfHours).toBeCloseTo(0, 6);
    expect(b.doubleTimeHours).toBeCloseTo(0, 6);
    expect(b.totalHours).toBeCloseTo(10, 6);
  });

  it("splits an early-start weekday shift across double / time-and-half / ordinary", () => {
    // 04:00-09:00 Mon: 04-05 double (1h), 05-07 t&h (2h), 07-09 ordinary (2h)
    const b = splitHoursByBand(mel("2026-07-06", 4), mel("2026-07-06", 9));
    expect(b.doubleTimeHours).toBeCloseTo(1, 6);
    expect(b.timeAndHalfHours).toBeCloseTo(2, 6);
    expect(b.normalHours).toBeCloseTo(2, 6);
    expect(b.totalHours).toBeCloseTo(5, 6);
  });

  it("splits an evening weekday shift 16:00-20:00 as ordinary / time-and-half / double", () => {
    // 16-17 ordinary (1h), 17-19 t&h (2h), 19-20 double (1h)
    const b = splitHoursByBand(mel("2026-07-06", 16), mel("2026-07-06", 20));
    expect(b.normalHours).toBeCloseTo(1, 6);
    expect(b.timeAndHalfHours).toBeCloseTo(2, 6);
    expect(b.doubleTimeHours).toBeCloseTo(1, 6);
  });

  it("prices an entire Saturday shift at double time (no time-and-half tier on weekends)", () => {
    const b = splitHoursByBand(mel("2026-07-11", 8), mel("2026-07-11", 16));
    expect(b.doubleTimeHours).toBeCloseTo(8, 6);
    expect(b.normalHours).toBeCloseTo(0, 6);
    expect(b.timeAndHalfHours).toBeCloseTo(0, 6);
  });

  it("handles a shift crossing midnight from Friday into Saturday", () => {
    // Fri 2026-07-10 22:00 -> Sat 2026-07-11 02:00.
    // Fri 22-24 = double (2h, weekday evening), Sat 00-02 = double (2h, weekend)
    const b = splitHoursByBand(mel("2026-07-10", 22), mel("2026-07-11", 2));
    expect(b.doubleTimeHours).toBeCloseTo(4, 6);
    expect(b.totalHours).toBeCloseTo(4, 6);
  });

  it("returns an empty breakdown for zero-length or inverted intervals", () => {
    expect(splitHoursByBand(mel("2026-07-06", 9), mel("2026-07-06", 9)).totalHours).toBe(0);
    expect(splitHoursByBand(mel("2026-07-06", 12), mel("2026-07-06", 9)).totalHours).toBe(0);
  });

  it("returns an empty breakdown for unparseable inputs rather than NaN", () => {
    const b = splitHoursByBand("not-a-date", "also-not");
    expect(b.totalHours).toBe(0);
    expect(Number.isNaN(b.totalHours)).toBe(false);
  });
});

describe("applyRateOverride", () => {
  const breakdown: HourBreakdown = {
    normalHours: 4,
    timeAndHalfHours: 2,
    doubleTimeHours: 2,
    totalHours: 8,
  };

  it("is a no-op when override is null or undefined", () => {
    expect(applyRateOverride(breakdown, null)).toEqual(breakdown);
    expect(applyRateOverride(breakdown, undefined)).toEqual(breakdown);
  });

  it("collapses all hours into the overridden band, preserving the total", () => {
    const normal = applyRateOverride(breakdown, "normal");
    expect(normal).toEqual({ normalHours: 8, timeAndHalfHours: 0, doubleTimeHours: 0, totalHours: 8 });

    const double = applyRateOverride(breakdown, "double_time");
    expect(double).toEqual({ normalHours: 0, timeAndHalfHours: 0, doubleTimeHours: 8, totalHours: 8 });
  });
});

describe("computeLabourCharge", () => {
  const breakdown: HourBreakdown = {
    normalHours: 8,
    timeAndHalfHours: 2,
    doubleTimeHours: 1,
    totalHours: 11,
  };

  it("prices a qualified tradesperson at the flat base rate with overtime multipliers stacked", () => {
    const r = computeLabourCharge({ tradeLevel: "qualified", breakdown, rateConfig: DEFAULT_LABOUR_RATE_CONFIG });
    expect(r.ordinaryHourlyRate).toBe(130);
    expect(r.timeAndHalfHourlyRate).toBe(195); // 130 * 1.5
    expect(r.doubleTimeHourlyRate).toBe(260); // 130 * 2
    expect(r.normalCharge).toBe(1040); // 8 * 130
    expect(r.timeAndHalfCharge).toBe(390); // 2 * 195
    expect(r.doubleTimeCharge).toBe(260); // 1 * 260
    expect(r.totalCharge).toBe(1690);
  });

  it("prices an apprentice at their loaded cost plus the configured margin", () => {
    const r = computeLabourCharge({
      tradeLevel: "apprentice",
      breakdown,
      rateConfig: DEFAULT_LABOUR_RATE_CONFIG,
      loadedHourlyCost: 50,
    });
    expect(r.ordinaryHourlyRate).toBeCloseTo(65, 6); // 50 * (1 + 30/100)
    expect(r.doubleTimeHourlyRate).toBeCloseTo(130, 6); // 65 * 2
  });

  it("lets a per-employee charge-out rate override both qualified and apprentice calculations", () => {
    const r = computeLabourCharge({
      tradeLevel: "qualified",
      breakdown,
      rateConfig: DEFAULT_LABOUR_RATE_CONFIG,
      staffChargeOutRate: 160,
    });
    expect(r.ordinaryHourlyRate).toBe(160);
    expect(r.timeAndHalfHourlyRate).toBe(240); // 160 * 1.5
  });

  it("ignores a zero/negative charge-out rate and falls back to the trade-level calc", () => {
    const r = computeLabourCharge({
      tradeLevel: "qualified",
      breakdown,
      rateConfig: DEFAULT_LABOUR_RATE_CONFIG,
      staffChargeOutRate: 0,
    });
    expect(r.ordinaryHourlyRate).toBe(130); // fell back to base rate
  });
});
