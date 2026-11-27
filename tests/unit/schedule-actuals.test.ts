import { describe, it, expect } from "vitest";
import {
  actualBarGeometry,
  actualLabel,
  actualLine,
  clockTime,
  clockedHoursFor,
  entrySpans,
  layoutUnbookedDay,
  layoutUnbookedWeek,
  scheduleActuals,
  type ActualBooking,
  type ActualEntry,
} from "@/lib/schedule-actuals";

// Melbourne is UTC+11 in November (daylight time).
const mel = (local: string) => new Date(`${local}+11:00`).toISOString();

const entry = (over: Partial<ActualEntry> = {}): ActualEntry => ({
  id: "e1",
  job_id: "j1",
  staff_id: "dave",
  clock_in: mel("2026-11-24T07:42:00"),
  clock_out: mel("2026-11-24T15:10:00"),
  entry_type: "work",
  ...over,
});

const booking = (over: Partial<ActualBooking> = {}): ActualBooking => ({
  id: "b1",
  job_id: "j1",
  staff_id: "dave",
  starts_at: mel("2026-11-24T07:00:00"),
  ends_at: mel("2026-11-24T15:30:00"),
  daily: false,
  all_day: false,
  ...over,
});

const NOW = Date.parse(mel("2026-11-27T12:00:00"));

describe("entrySpans", () => {
  it("gives one span for a day's work, with its hours", () => {
    const [s] = entrySpans(entry(), NOW);
    expect(s.dateKey).toBe("2026-11-24");
    expect(s.hours).toBeCloseTo(7.47, 2);
    expect(s.open).toBe(false);
  });

  it("splits an entry across midnight into two Melbourne days", () => {
    const spans = entrySpans(entry({ clock_in: mel("2026-11-24T22:00:00"), clock_out: mel("2026-11-25T02:30:00") }), NOW);
    expect(spans.map((s) => s.dateKey)).toEqual(["2026-11-24", "2026-11-25"]);
    expect(spans.map((s) => s.hours)).toEqual([2, 2.5]);
    expect(spans[0].endIso).toBe(mel("2026-11-25T00:00:00"));
  });

  it("runs an open entry to now", () => {
    const now = Date.parse(mel("2026-11-24T11:00:00"));
    const [s] = entrySpans(entry({ clock_out: null }), now);
    expect(s.open).toBe(true);
    expect(s.stale).toBe(false);
    expect(s.endIso).toBe(new Date(now).toISOString());
  });

  it("caps a forgotten clock-off at 16 hours and flags it", () => {
    const spans = entrySpans(entry({ clock_out: null }), NOW);
    expect(spans.every((s) => s.stale)).toBe(true);
    expect(spans.reduce((sum, s) => sum + s.hours, 0)).toBeCloseTo(16, 5);
    expect(spans.map((s) => s.dateKey)).toEqual(["2026-11-24"]);
  });

  it("ignores travel, entries with no job or staff, and backwards clock-offs", () => {
    expect(entrySpans(entry({ entry_type: "travel" }), NOW)).toEqual([]);
    expect(entrySpans(entry({ job_id: null }), NOW)).toEqual([]);
    expect(entrySpans(entry({ staff_id: null }), NOW)).toEqual([]);
    expect(entrySpans(entry({ clock_out: mel("2026-11-24T07:00:00") }), NOW)).toEqual([]);
  });
});

describe("scheduleActuals", () => {
  it("matches time to the technician's booking on that job and day", () => {
    const a = scheduleActuals([entry()], [booking()], NOW);
    expect(a.byBooking["b1|2026-11-24"]).toHaveLength(1);
    expect(a.unbooked).toEqual({});
    expect(clockedHoursFor(a, "dave", "2026-11-24")).toBeCloseTo(7.47, 2);
  });

  it("is unbooked when there's no booking that day", () => {
    const a = scheduleActuals([entry()], [booking({ starts_at: mel("2026-11-25T07:00:00"), ends_at: mel("2026-11-25T15:30:00") })], NOW);
    expect(a.byBooking).toEqual({});
    expect(a.unbooked["dave|2026-11-24"]).toHaveLength(1);
  });

  it("counts time on a job booked for someone else as unbooked for this technician", () => {
    const a = scheduleActuals([entry()], [booking({ staff_id: "sam" })], NOW);
    expect(a.byBooking).toEqual({});
    expect(a.unbooked["dave|2026-11-24"][0].bookingId).toBeNull();
  });

  it("puts two entries the same day on the booking, in order, and totals them", () => {
    const a = scheduleActuals(
      [
        entry({ id: "e2", clock_in: mel("2026-11-24T12:30:00"), clock_out: mel("2026-11-24T15:00:00") }),
        entry({ id: "e1", clock_in: mel("2026-11-24T07:00:00"), clock_out: mel("2026-11-24T12:00:00") }),
      ],
      [booking()],
      NOW,
    );
    expect(a.byBooking["b1|2026-11-24"].map((s) => s.entryId)).toEqual(["e1", "e2"]);
    expect(clockedHoursFor(a, "dave", "2026-11-24")).toBe(7.5);
    expect(actualLine(a.byBooking["b1|2026-11-24"])).toBe("Clocked 7:00–12:00, 12:30–3:00 · 7.5 h");
  });

  it("matches each day of a multi-day daily booking (0071 day rules)", () => {
    const a = scheduleActuals(
      [entry({ id: "mon" }), entry({ id: "wed", clock_in: mel("2026-11-26T07:00:00"), clock_out: mel("2026-11-26T15:00:00") })],
      [booking({ ends_at: mel("2026-11-26T15:30:00"), daily: true })],
      NOW,
    );
    expect(Object.keys(a.byBooking).sort()).toEqual(["b1|2026-11-24", "b1|2026-11-26"]);
  });

  it("picks the booking the time overlaps most when there are two that day", () => {
    const a = scheduleActuals(
      [entry({ clock_in: mel("2026-11-24T12:30:00"), clock_out: mel("2026-11-24T15:00:00") })],
      [
        booking({ id: "am", ends_at: mel("2026-11-24T12:00:00") }),
        booking({ id: "pm", starts_at: mel("2026-11-24T12:00:00") }),
      ],
      NOW,
    );
    expect(Object.keys(a.byBooking)).toEqual(["pm|2026-11-24"]);
  });

  it("still shows time on a completed job (status isn't read)", () => {
    const a = scheduleActuals([entry()], [booking()], NOW);
    expect(a.byBooking["b1|2026-11-24"]).toBeDefined();
  });

  it("counts an entry once even if it's read twice", () => {
    const a = scheduleActuals([entry(), entry()], [booking()], NOW);
    expect(a.byBooking["b1|2026-11-24"]).toHaveLength(1);
  });
});

describe("labels", () => {
  it("reads Melbourne wall-clock times without am/pm", () => {
    expect(clockTime(mel("2026-11-24T07:42:00"))).toBe("7:42");
    expect(clockTime(mel("2026-11-24T15:10:00"))).toBe("3:10");
  });

  it("says on now / no clock-off", () => {
    const now = Date.parse(mel("2026-11-24T11:00:00"));
    expect(actualLabel(entrySpans(entry({ clock_out: null }), now))).toBe("Clocked 7:42 – on now");
    expect(actualLabel(entrySpans(entry({ clock_out: null }), NOW))).toBe("Clocked 7:42 – still on? (no clock-off)");
    expect(actualLabel([])).toBeNull();
  });
});

describe("geometry", () => {
  const range = { startHour: 6, endHour: 19 };
  it("puts the bar at the real times", () => {
    const [s] = entrySpans(entry({ clock_in: mel("2026-11-24T07:30:00"), clock_out: mel("2026-11-24T15:00:00") }), NOW);
    expect(actualBarGeometry(s, range, 80)).toEqual({ left: 120, width: 600 });
  });

  it("lays unbooked spans in their own lanes", () => {
    const spans = [
      ...entrySpans(entry({ id: "a", clock_in: mel("2026-11-24T07:00:00"), clock_out: mel("2026-11-24T10:00:00") }), NOW),
      ...entrySpans(entry({ id: "b", clock_in: mel("2026-11-24T09:00:00"), clock_out: mel("2026-11-24T11:00:00") }), NOW),
    ];
    expect(layoutUnbookedDay(spans, range, 80).lanes).toBe(2);
    const week = layoutUnbookedWeek(["2026-11-23", "2026-11-24"], (k) => (k === "2026-11-24" ? spans : []), 100);
    expect(week.lanes).toBe(2);
    expect(week.items[0].left).toBe(103);
  });
});
