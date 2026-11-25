import { describe, it, expect } from "vitest";
import {
  hourlyQuantity,
  hoursByVariation,
  isHourlyVariation,
  isHourUnit,
  isMissingVariationColumn,
  openVariations,
  planClockSwitch,
  stageEntries,
  variationHoursText,
  variationLabel,
  variationName,
  variationTimeRefusal,
} from "@/lib/variation-time";
import { computeHoursScoreboard } from "@/lib/hours-scoreboard";
import { summariseJobHours } from "@/lib/over-hours";

// Time against variations (0120, Justin 25 Nov 2026): crew tag time to a
// variation; it never counts toward the stage's allowed hours; an hourly
// variation takes its quantity from the hours logged to it.

describe("hourly variations", () => {
  it("knows an hour unit", () => {
    for (const u of ["h", "hr", "Hrs", " hour ", "HOURS", "per hour"]) expect(isHourUnit(u)).toBe(true);
    for (const u of ["m³", "unit", "lm", "", null]) expect(isHourUnit(u)).toBe(false);
  });

  it("the office's call beats the unit", () => {
    expect(isHourlyVariation({ unit: "hr", is_hourly: null })).toBe(true);
    expect(isHourlyVariation({ unit: "hr", is_hourly: false })).toBe(false);
    expect(isHourlyVariation({ unit: "unit", is_hourly: true })).toBe(true);
    expect(isHourlyVariation({ unit: "m³" })).toBe(false);
  });

  it("adds each variation's clocked-off work hours, and counts who is still on", () => {
    const h = hoursByVariation([
      { variation_id: "a", hours: 2.5, clock_in: "2026-11-25T00:00:00Z", clock_out: "2026-11-25T02:30:00Z", entry_type: "work" },
      { variation_id: "a", hours: "4", clock_in: "2026-11-25T03:00:00Z", clock_out: "2026-11-25T07:00:00Z", entry_type: "work" },
      { variation_id: "a", hours: null, clock_in: "2026-11-25T08:00:00Z", clock_out: null, entry_type: "work" },
      { variation_id: "b", hours: 1, clock_in: "2026-11-25T00:00:00Z", clock_out: "2026-11-25T01:00:00Z", entry_type: "travel" },
      { variation_id: null, hours: 8, clock_in: "2026-11-25T00:00:00Z", clock_out: "2026-11-25T08:00:00Z", entry_type: "work" },
    ]);
    expect(h).toEqual({ a: { hours: 6.5, running: 1 } });
    expect(variationHoursText(h.a)).toBe("6.5 h logged, 1 still clocked on");
    expect(variationHoursText(undefined)).toBe("No time logged");
    expect(hourlyQuantity(6.499)).toBe(6.5);
  });
});

describe("names and lists", () => {
  it("names a variation by its type, else its custom name", () => {
    expect(variationName({ variation_types: { name: "Rock removal" }, custom_name: null })).toBe("Rock removal");
    expect(variationName({ custom_name: "Hit rock" })).toBe("Hit rock");
    expect(variationName({ custom_name: "  " })).toBe("Variation");
    expect(variationLabel({ custom_name: "Hit rock", status: "pending_approval" })).toBe("Variation: Hit rock (waiting for the office)");
  });

  it("time can go against any variation that isn't rejected", () => {
    const list = [
      { id: "1", status: "pending_approval" },
      { id: "2", status: "rejected" },
      { id: "3", status: "approved" },
      { id: "4", status: "auto_approved" },
    ];
    expect(openVariations(list).map((v) => v.id)).toEqual(["1", "3", "4"]);
  });
});

describe("variation time never counts toward the stage's allowed hours", () => {
  const entries = [
    { job_id: "j", cost_center_id: "l", hours: 10, clock_in: "2026-11-25T00:00:00Z", clock_out: "2026-11-25T10:00:00Z", entry_type: "work" },
    { job_id: "j", cost_center_id: "l", hours: 6, clock_in: "2026-11-25T00:00:00Z", clock_out: "2026-11-25T06:00:00Z", entry_type: "work", variation_id: "v" },
  ];

  it("over-hours leaves it out of the line and the job", () => {
    const h = summariseJobHours({ pos: [], lines: [{ id: "l", job_id: "j", name: "Sewer", allocated_hours: 16 }], entries, nowMs: Date.parse("2026-11-25T12:00:00Z") });
    expect(h.j.usedHours).toBe(10);
    expect(h.j.lines.l.usedHours).toBe(10);
  });

  it("the hours scoreboard leaves it out, open entries included", () => {
    const s = computeHoursScoreboard(
      16,
      [
        ...entries,
        { hours: null, clock_in: "2026-11-25T11:00:00Z", clock_out: null, entry_type: "work", variation_id: "v" },
      ],
      Date.parse("2026-11-25T12:00:00Z")
    );
    expect(s.loggedHours).toBe(10);
    expect(s.openClockIn).toBeNull();
  });

  it("stageEntries drops it", () => {
    expect(stageEntries(entries)).toHaveLength(1);
  });
});

describe("switching while clocked on", () => {
  it("ends the open entry and starts the next at the same instant", () => {
    const p = planClockSwitch({ clock_in: "2026-11-25T00:00:00Z" }, { costCenterId: "l", variationId: "v" }, "2026-11-25T03:00:00.000Z");
    expect(p).toEqual({ clockOutIso: "2026-11-25T03:00:00.000Z", clockInIso: "2026-11-25T03:00:00.000Z" });
  });

  it("does nothing when already on that target", () => {
    expect(planClockSwitch({ clock_in: "2026-11-25T00:00:00Z", variation_id: "v" }, { costCenterId: null, variationId: "v" }, "2026-11-25T03:00:00Z")).toBeNull();
    expect(planClockSwitch({ clock_in: "2026-11-25T00:00:00Z" }, { costCenterId: null, variationId: null }, "2026-11-25T03:00:00Z")).toBeNull();
  });

  it("never ends an entry at or before its own start (a clock that moved)", () => {
    const p = planClockSwitch({ clock_in: "2026-11-25T03:00:00Z" }, { costCenterId: null, variationId: "v" }, "2026-11-25T02:59:00Z");
    expect(p!.clockOutIso).toBe("2026-11-25T03:00:01.000Z");
  });
});

describe("errors", () => {
  it("turns 0120's refusals into sentences", () => {
    expect(variationTimeRefusal("That variation is on another job.")).toBe("That variation is on another job.");
    expect(variationTimeRefusal("That variation was rejected — time can't go against it.")).toMatch(/rejected/);
    expect(variationTimeRefusal("Travel time can't go against a variation.")).toMatch(/Travel/);
    expect(variationTimeRefusal("something else")).toBeNull();
  });

  it("knows a database without 0120", () => {
    expect(isMissingVariationColumn({ code: "42703", message: "column time_entries.variation_id does not exist" })).toBe(true);
    expect(isMissingVariationColumn({ code: "PGRST204", message: "Could not find the 'variation_id' column of 'time_entries'" })).toBe(true);
    expect(isMissingVariationColumn({ code: "42703", message: "column time_entries.other does not exist" })).toBe(false);
    expect(isMissingVariationColumn({ code: "42501", message: "variation_id permission denied" })).toBe(false);
    expect(isMissingVariationColumn(null)).toBe(false);
  });
});
