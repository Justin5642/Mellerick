import {
  plausibleAutoClockHours,
  MAX_PLAUSIBLE_TRAVEL_HOURS,
  MAX_PLAUSIBLE_WORK_HOURS,
} from "./autoClockHours";

// The geofence auto-clock writes time entries with no human in the loop: it
// clocks a technician in on arrival and out on departure, and those hours go to
// payroll. The travel path already refused implausible durations; the WORK path
// wrote whatever the subtraction produced.
//
// Two ways that goes wrong in the field, both silent:
//   - the phone's clock corrects itself between arrival and departure, so
//     clock_out precedes clock_in and the entry carries NEGATIVE hours, which
//     subtracts from a technician's pay;
//   - the app misses the departure event (killed, permission revoked, phone
//     flat) and the entry stays open until the technician returns days later.
//
// `hours` is nullable in production, so an implausible duration is recorded as
// null — the entry still closes, and the office sees a gap to correct rather
// than a wrong number that reconciles silently.

const iso = (ms: number) => new Date(ms).toISOString();
const T0 = Date.parse("2026-08-03T08:00:00.000Z");
const H = 3600000;

describe("plausibleAutoClockHours", () => {
  it("returns rounded hours for an ordinary shift", () => {
    expect(plausibleAutoClockHours(iso(T0), iso(T0 + 7.5 * H), MAX_PLAUSIBLE_WORK_HOURS)).toBe(7.5);
  });

  it("rounds to two decimal places, as the manual path does", () => {
    // 1,000,000 ms = 0.2777… h, which must round to 0.28 rather than carry the
    // full float into a payroll figure.
    expect(plausibleAutoClockHours(iso(T0), iso(T0 + 1_000_000), MAX_PLAUSIBLE_WORK_HOURS)).toBe(0.28);
  });

  // THE PAYROLL BUG. A backward clock correction makes clock_out precede
  // clock_in; the old code wrote the negative result straight to the entry.
  it("returns null when the end precedes the start (backward clock jump)", () => {
    expect(plausibleAutoClockHours(iso(T0), iso(T0 - H), MAX_PLAUSIBLE_WORK_HOURS)).toBeNull();
  });

  it("returns null for a zero-length entry", () => {
    expect(plausibleAutoClockHours(iso(T0), iso(T0), MAX_PLAUSIBLE_WORK_HOURS)).toBeNull();
  });

  it("returns null when the shift exceeds what a person plausibly works", () => {
    // Missed departure event: the entry sat open until the technician returned.
    expect(plausibleAutoClockHours(iso(T0), iso(T0 + 30 * H), MAX_PLAUSIBLE_WORK_HOURS)).toBeNull();
  });

  it("accepts a long but plausible shift at the boundary", () => {
    expect(
      plausibleAutoClockHours(iso(T0), iso(T0 + MAX_PLAUSIBLE_WORK_HOURS * H), MAX_PLAUSIBLE_WORK_HOURS)
    ).toBe(MAX_PLAUSIBLE_WORK_HOURS);
  });

  it("applies the tighter travel ceiling on the travel path", () => {
    const fourHours = plausibleAutoClockHours(iso(T0), iso(T0 + 4 * H), MAX_PLAUSIBLE_TRAVEL_HOURS);
    expect(fourHours).toBeNull(); // four hours between two sites is not travel
    expect(plausibleAutoClockHours(iso(T0), iso(T0 + 2 * H), MAX_PLAUSIBLE_TRAVEL_HOURS)).toBe(2);
  });

  it("returns null for an unparseable timestamp rather than NaN", () => {
    // NaN would reach the database as null regardless, but silently. Being
    // explicit routes it down the same documented path as every other
    // implausible entry.
    expect(plausibleAutoClockHours("not-a-date", iso(T0), MAX_PLAUSIBLE_WORK_HOURS)).toBeNull();
    expect(plausibleAutoClockHours(iso(T0), "not-a-date", MAX_PLAUSIBLE_WORK_HOURS)).toBeNull();
  });

  it("keeps the travel ceiling tighter than the work ceiling", () => {
    expect(MAX_PLAUSIBLE_TRAVEL_HOURS).toBeLessThan(MAX_PLAUSIBLE_WORK_HOURS);
  });
});
