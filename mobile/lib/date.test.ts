import { withDateKeyPreservingTime, computeReschedule, toBusinessInputValue, fromBusinessInputValue } from "./date";

describe("Melbourne business-time conversions", () => {
  it("round-trips a winter (AEST +10) wall-clock time through UTC", () => {
    // 9:00am AEST on 28 Jul 2026 == 23:00 UTC on 27 Jul.
    expect(fromBusinessInputValue("2026-07-28T09:00")).toBe("2026-07-27T23:00:00.000Z");
    expect(toBusinessInputValue("2026-07-27T23:00:00.000Z")).toBe("2026-07-28T09:00");
  });

  it("round-trips a summer (AEDT +11) wall-clock time through UTC", () => {
    // 9:00am AEDT on 15 Jan 2026 == 22:00 UTC on 14 Jan.
    expect(fromBusinessInputValue("2026-01-15T09:00")).toBe("2026-01-14T22:00:00.000Z");
    expect(toBusinessInputValue("2026-01-14T22:00:00.000Z")).toBe("2026-01-15T09:00");
  });
});

describe("withDateKeyPreservingTime", () => {
  it("moves an instant to a new Melbourne calendar day, keeping the time-of-day", () => {
    // 9am AEST 28 Jul → 9am AEST 30 Jul
    expect(withDateKeyPreservingTime("2026-07-27T23:00:00.000Z", "2026-07-30")).toBe("2026-07-29T23:00:00.000Z");
  });
});

describe("computeReschedule", () => {
  it("keeps the start time-of-day and preserves the duration (AEST)", () => {
    const r = computeReschedule("2026-07-27T23:00:00.000Z" /* 9am */, "2026-07-28T01:00:00.000Z" /* 11am, +2h */, "2026-07-30");
    expect(r.scheduledStartIso).toBe("2026-07-29T23:00:00.000Z"); // 9am AEST 30 Jul
    expect(r.scheduledEndIso).toBe("2026-07-30T01:00:00.000Z"); // 11am AEST 30 Jul — duration kept
  });

  it("keeps the time-of-day across the summer offset (AEDT)", () => {
    const r = computeReschedule("2026-01-14T22:00:00.000Z" /* 9am AEDT */, null, "2026-01-20");
    expect(r.scheduledStartIso).toBe("2026-01-19T22:00:00.000Z"); // 9am AEDT 20 Jan
    expect(r.scheduledEndIso).toBeNull();
  });

  it("returns a null end when the job had no scheduled_end", () => {
    expect(computeReschedule("2026-07-27T23:00:00.000Z", null, "2026-08-01").scheduledEndIso).toBeNull();
  });
});
