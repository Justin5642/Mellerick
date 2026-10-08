import { describe, it, expect } from "vitest";
import { computeHoursScoreboard, scoreboardTone, sumAllocatedHours } from "@/lib/hours-scoreboard";

const NOW = Date.parse("2026-10-08T12:00:00Z");

describe("sumAllocatedHours", () => {
  it("sums total_hours across POs, treating null/garbage as 0", () => {
    expect(sumAllocatedHours([{ total_hours: 4 }, { total_hours: "2.5" }, { total_hours: null }, { total_hours: "x" }])).toBe(6.5);
    expect(sumAllocatedHours([])).toBe(0);
  });
});

describe("scoreboardTone", () => {
  it("uses the same thresholds as the office scoreboard", () => {
    expect(scoreboardTone(0)).toBe("green");
    expect(scoreboardTone(74.9)).toBe("green");
    expect(scoreboardTone(75)).toBe("orange");
    expect(scoreboardTone(94.9)).toBe("orange");
    expect(scoreboardTone(95)).toBe("red");
  });
});

describe("computeHoursScoreboard", () => {
  it("counts closed work entries and ignores travel", () => {
    const s = computeHoursScoreboard(10, [
      { hours: 3, clock_in: "2026-10-08T00:00:00Z", clock_out: "2026-10-08T03:00:00Z", entry_type: "work" },
      { hours: 2, clock_in: "2026-10-08T04:00:00Z", clock_out: "2026-10-08T06:00:00Z", entry_type: "travel" },
    ], NOW);
    expect(s.loggedHours).toBe(3);
    expect(s.pct).toBe(30);
    expect(s.remainingHours).toBe(7);
    expect(s.exceeded).toBe(false);
    expect(s.openClockIn).toBeNull();
    expect(s.tone).toBe("green");
  });

  it("adds live hours for an open work entry", () => {
    const s = computeHoursScoreboard(4, [
      { hours: 1, clock_in: "2026-10-08T06:00:00Z", clock_out: "2026-10-08T07:00:00Z", entry_type: "work" },
      { hours: null, clock_in: "2026-10-08T10:00:00Z", clock_out: null, entry_type: "work" },
    ], NOW);
    expect(s.openClockIn).toBe("2026-10-08T10:00:00Z");
    expect(s.loggedHours).toBeCloseTo(3);
    expect(s.pct).toBeCloseTo(75);
    expect(s.tone).toBe("orange");
  });

  it("caps pct at 100, floors remaining at 0 and flags exceeded", () => {
    const s = computeHoursScoreboard(2, [
      { hours: "5", clock_in: "2026-10-08T00:00:00Z", clock_out: "2026-10-08T05:00:00Z" },
    ], NOW);
    expect(s.pct).toBe(100);
    expect(s.remainingHours).toBe(0);
    expect(s.exceeded).toBe(true);
    expect(s.tone).toBe("red");
  });

  it("reports nothing allocated without dividing by zero", () => {
    const s = computeHoursScoreboard(0, [{ hours: 1, clock_in: "a", clock_out: "b" }], NOW);
    expect(s.pct).toBe(0);
    expect(s.exceeded).toBe(false);
  });

  it("returns no money-shaped field", () => {
    const keys = Object.keys(computeHoursScoreboard(1, [], NOW));
    expect(keys.some((k) => /value|amount|cost|price|rate|\$/i.test(k))).toBe(false);
  });
});
