import { describe, it, expect } from "vitest";
import {
  BUSINESS_TIME_ZONE,
  formatTime,
  formatDate,
  formatDateTime,
  dateKeyInBusinessTZ,
  isTodayInBusinessTZ,
  toBusinessInputValue,
  fromBusinessInputValue,
  businessDateParts,
} from "@/lib/date";

// lib/date.ts caches its Intl.DateTimeFormat instances instead of calling
// toLocale*String with a timeZone (which builds a new formatter every call).
// That is only safe if every output is byte-identical to the calls it
// replaced — these are those original calls, verbatim, as the oracle.
const original = {
  formatTime: (v: string | Date) =>
    new Date(v).toLocaleTimeString("en-AU", { hour: "2-digit", minute: "2-digit", timeZone: BUSINESS_TIME_ZONE }),
  formatDate: (v: string | Date, opts: Intl.DateTimeFormatOptions = { day: "numeric", month: "short" }) =>
    new Date(v).toLocaleDateString("en-AU", { ...opts, timeZone: BUSINESS_TIME_ZONE }),
  dateKey: (v: string | Date) => new Date(v).toLocaleDateString("en-CA", { timeZone: BUSINESS_TIME_ZONE }),
  formatDateTime: (v: string | Date) => new Date(v).toLocaleString("en-AU", { timeZone: BUSINESS_TIME_ZONE }),
};

// Every option set formatDate is called with in app/ and components/.
const FORMAT_DATE_OPTIONS: (Intl.DateTimeFormatOptions | undefined)[] = [
  undefined,
  { day: "numeric" },
  { day: "numeric", month: "short" },
  { day: "numeric", month: "short", year: "numeric" },
  { month: "short", year: "2-digit" },
  { weekday: "long", day: "numeric", month: "long" },
  { weekday: "long", day: "numeric", month: "long", year: "numeric" },
  { weekday: "short" },
  { weekday: "short", day: "numeric", month: "short" },
];

// Melbourne DST in 2026: ends 5 April 03:00 AEDT -> 02:00 AEST (16:00 UTC on
// 4 April); starts 4 October 02:00 AEST -> 03:00 AEDT (16:00 UTC on 3 October).
// Sample every 15 minutes across 36 hours either side of each, which crosses
// the transition itself and both Melbourne midnights next to it.
function instantsAround(isoUtc: string) {
  const centre = Date.parse(isoUtc);
  const out: Date[] = [];
  for (let m = -36 * 60; m <= 36 * 60; m += 15) out.push(new Date(centre + m * 60_000));
  return out;
}
const DST_END = instantsAround("2026-04-04T16:00:00Z");
const DST_START = instantsAround("2026-10-03T16:00:00Z");
const SAMPLES = [...DST_END, ...DST_START, new Date("2025-12-31T13:00:00Z"), new Date(0)];

describe("lib/date cached formatters match the toLocale*String calls they replaced", () => {
  it("formatTime, dateKeyInBusinessTZ and formatDateTime across both DST boundaries", () => {
    for (const d of SAMPLES) {
      expect(formatTime(d)).toBe(original.formatTime(d));
      expect(dateKeyInBusinessTZ(d)).toBe(original.dateKey(d));
      expect(formatDateTime(d)).toBe(original.formatDateTime(d));
      // String input goes through the same new Date(value) path.
      expect(dateKeyInBusinessTZ(d.toISOString())).toBe(original.dateKey(d.toISOString()));
    }
  });

  it("formatDate with every option set in use, across both DST boundaries", () => {
    for (const opts of FORMAT_DATE_OPTIONS) {
      for (const d of SAMPLES) {
        expect(formatDate(d, opts)).toBe(original.formatDate(d, opts));
      }
    }
  });

  it("the date key flips at Melbourne midnight, not UTC midnight, on both sides of DST", () => {
    // AEDT (+11): Melbourne midnight 4 April = 13:00 UTC 3 April.
    expect(dateKeyInBusinessTZ("2026-04-03T12:59:00Z")).toBe("2026-04-03");
    expect(dateKeyInBusinessTZ("2026-04-03T13:00:00Z")).toBe("2026-04-04");
    // AEST (+10): Melbourne midnight 6 April = 14:00 UTC 5 April.
    expect(dateKeyInBusinessTZ("2026-04-05T13:59:00Z")).toBe("2026-04-05");
    expect(dateKeyInBusinessTZ("2026-04-05T14:00:00Z")).toBe("2026-04-06");
    // AEDT again after 4 October: Melbourne midnight 5 October = 13:00 UTC 4 October.
    expect(dateKeyInBusinessTZ("2026-10-04T12:59:00Z")).toBe("2026-10-04");
    expect(dateKeyInBusinessTZ("2026-10-04T13:00:00Z")).toBe("2026-10-05");
  });

  it("an invalid date still returns 'Invalid Date' rather than throwing", () => {
    const bad = "not a date";
    expect(formatTime(bad)).toBe(original.formatTime(bad));
    expect(formatDate(bad)).toBe(original.formatDate(bad));
    expect(dateKeyInBusinessTZ(bad)).toBe(original.dateKey(bad));
    expect(formatDateTime(bad)).toBe(original.formatDateTime(bad));
  });

  it("isTodayInBusinessTZ compares Melbourne date keys", () => {
    expect(isTodayInBusinessTZ(new Date())).toBe(true);
    expect(isTodayInBusinessTZ(new Date(Date.now() - 3 * 86_400_000))).toBe(false);
  });

  it("input-value round trip and date parts are unchanged across DST", () => {
    for (const d of SAMPLES) {
      const value = toBusinessInputValue(d);
      expect(value).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
      const parts = businessDateParts(d);
      expect(`${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`).toBe(
        original.dateKey(d),
      );
    }
    expect(toBusinessInputValue("2026-10-03T15:30:00Z")).toBe("2026-10-04T01:30");
    expect(toBusinessInputValue("2026-10-03T16:30:00Z")).toBe("2026-10-04T03:30");
    expect(fromBusinessInputValue("2026-10-04T09:00")).toBe("2026-10-03T22:00:00.000Z");
    expect(fromBusinessInputValue("2026-04-06T09:00")).toBe("2026-04-05T23:00:00.000Z");
  });
});
