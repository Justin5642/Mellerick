import { describe, it, expect } from "vitest";
import {
  buildCalendarEventBody,
  buildCalendarEventTiming,
  eventMatchesJob,
  instanceMatchesJob,
  type CalendarEventTiming,
} from "@/lib/calendar-event";
import { buildScheduleColumns, scheduleDays, type ScheduledJobWindow } from "@/lib/scheduling";
import { fromBusinessInputValue, shiftDateKey } from "@/lib/date";

// A multi-day job becomes ONE recurring Google event. The only thing that
// matters is that the occurrences Google will expand are exactly the days
// scheduleDays() books — so these tests expand the rule the way RFC 5545 does
// (DAILY in the TZID's wall time, UNTIL inclusive in UTC, minus EXDATEs) and
// compare, rather than pinning strings alone.

const at = (key: string, time: string) => fromBusinessInputValue(`${key}T${time}`);

const daily = (startKey: string, endKey: string, startTime = "07:00", endTime = "15:30"): ScheduledJobWindow =>
  buildScheduleColumns({ startDateKey: startKey, endDateKey: endKey, startTime, endTime, allDay: false });

/** Minimal RFC 5545 expansion of exactly the shape buildCalendarEventTiming emits. */
function expand(timing: CalendarEventTiming) {
  expect(timing.start.timeZone).toBe("Australia/Melbourne");
  const startKey = timing.start.dateTime.slice(0, 10);
  const startTime = timing.start.dateTime.slice(11, 16);
  const endTime = timing.end.dateTime.slice(11, 16);
  const rrule = timing.recurrence.find((l) => l.startsWith("RRULE:"));
  if (!rrule) {
    return [{ dateKey: startKey, startIso: at(startKey, startTime), endIso: at(startKey, endTime) }];
  }
  const untilBasic = /UNTIL=(\d{8}T\d{6}Z)/.exec(rrule)![1];
  const until = Date.parse(
    `${untilBasic.slice(0, 4)}-${untilBasic.slice(4, 6)}-${untilBasic.slice(6, 8)}T${untilBasic.slice(9, 11)}:${untilBasic.slice(11, 13)}:${untilBasic.slice(13, 15)}Z`
  );
  const exLine = timing.recurrence.find((l) => l.startsWith("EXDATE"));
  const exdates = new Set(
    exLine
      ? exLine
          .split(":")
          .slice(1)
          .join(":")
          .split(",")
          .map((v) => at(`${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}`, `${v.slice(9, 11)}:${v.slice(11, 13)}`))
      : []
  );
  const out = [];
  for (let key = startKey, i = 0; i < 1000; key = shiftDateKey(key, 1), i++) {
    const startIso = at(key, startTime);
    if (Date.parse(startIso) > until) break;
    if (exdates.has(startIso)) continue;
    out.push({ dateKey: key, startIso, endIso: at(key, endTime) });
  }
  return out;
}

describe("buildCalendarEventTiming — single-window jobs (unchanged)", () => {
  it("is one UTC event, with recurrence cleared", () => {
    const timing = buildCalendarEventTiming({
      scheduled_start: "2026-08-10T22:00:00.000Z",
      scheduled_end: "2026-08-11T01:00:00.000Z",
      schedule_daily: false,
    });
    expect(timing).toEqual({
      start: { dateTime: "2026-08-10T22:00:00.000Z" },
      end: { dateTime: "2026-08-11T01:00:00.000Z" },
      // Explicit [] so an update from a daily series back to one day drops the series.
      recurrence: [],
    });
  });

  it("defaults a missing end to an hour, as before", () => {
    const timing = buildCalendarEventTiming({ scheduled_start: "2026-08-10T22:00:00.000Z", scheduled_end: null });
    expect(timing?.end.dateTime).toBe("2026-08-10T23:00:00.000Z");
  });

  it("is null when unscheduled", () => {
    expect(buildCalendarEventTiming({ scheduled_start: null, scheduled_end: null, schedule_daily: true })).toBeNull();
  });
});

describe("buildCalendarEventTiming — multi-day jobs", () => {
  it("across the DST change (Fri 2 – Tue 6 Oct 2026): wall time + timeZone, weekend excluded", () => {
    const job = daily("2026-10-02", "2026-10-06");
    const timing = buildCalendarEventTiming(job)!;
    expect(timing).toEqual({
      start: { dateTime: "2026-10-02T07:00:00", timeZone: "Australia/Melbourne" },
      end: { dateTime: "2026-10-02T15:30:00", timeZone: "Australia/Melbourne" },
      recurrence: [
        // Tue 6 Oct 07:00 AEDT (+11) = Mon 5 Oct 20:00 UTC — the last occurrence's own start.
        "RRULE:FREQ=DAILY;UNTIL=20261005T200000Z",
        "EXDATE;TZID=Australia/Melbourne:20261003T070000,20261004T070000",
      ],
    });
    const occurrences = expand(timing);
    expect(occurrences.map((o) => o.dateKey)).toEqual(["2026-10-02", "2026-10-05", "2026-10-06"]);
    // 07:00 local on both sides of the change: +10 on Friday, +11 after.
    expect(occurrences[0].startIso).toBe("2026-10-01T21:00:00.000Z");
    expect(occurrences[1].startIso).toBe("2026-10-04T20:00:00.000Z");
    expect(occurrences).toEqual(scheduleDays(job));
  });

  it("books a weekend endpoint (Sat 24 – Tue 27 Oct): Saturday kept, Sunday excluded", () => {
    const job = daily("2026-10-24", "2026-10-27", "08:00", "12:00");
    const timing = buildCalendarEventTiming(job)!;
    expect(timing.start).toEqual({ dateTime: "2026-10-24T08:00:00", timeZone: "Australia/Melbourne" });
    expect(timing.recurrence).toEqual([
      "RRULE:FREQ=DAILY;UNTIL=20261026T210000Z",
      "EXDATE;TZID=Australia/Melbourne:20261025T080000",
    ]);
    expect(expand(timing).map((o) => o.dateKey)).toEqual(["2026-10-24", "2026-10-26", "2026-10-27"]);
    expect(expand(timing)).toEqual(scheduleDays(job));
  });

  it("has no EXDATE when no day is skipped", () => {
    const timing = buildCalendarEventTiming(daily("2026-10-19", "2026-10-21"))!;
    expect(timing.recurrence).toEqual(["RRULE:FREQ=DAILY;UNTIL=20261020T200000Z"]);
  });

  it("is a plain single event when only one day is booked", () => {
    const job = { ...daily("2026-10-19", "2026-10-19"), schedule_daily: true };
    expect(buildCalendarEventTiming(job)).toEqual({
      start: { dateTime: "2026-10-19T07:00:00", timeZone: "Australia/Melbourne" },
      end: { dateTime: "2026-10-19T15:30:00", timeZone: "Australia/Melbourne" },
      recurrence: [],
    });
  });

  it("reproduces scheduleDays exactly for every start/length over two months, DST included", () => {
    for (let s = 0; s < 60; s++) {
      const startKey = shiftDateKey("2026-09-20", s);
      for (const len of [1, 2, 3, 6, 9, 15]) {
        const job = daily(startKey, shiftDateKey(startKey, len));
        expect(expand(buildCalendarEventTiming(job)!)).toEqual(scheduleDays(job));
      }
    }
  });
});

describe("buildCalendarEventBody", () => {
  it("keeps the summary, description and location and adds the timing", () => {
    const body = buildCalendarEventBody({
      ...daily("2026-10-02", "2026-10-06"),
      job_number: 812,
      title: "Hot water",
      description: "Replace unit",
      customers: { name: "Acme" },
      sites: { address_line1: "1 Main St", suburb: "Nutfield", state: "VIC", postcode: "3099" },
    })!;
    expect(body).toMatchObject({
      summary: "#812 — Hot water",
      description: "Replace unit\n\nCustomer: Acme",
      location: "1 Main St, Nutfield, VIC, 3099",
      start: { timeZone: "Australia/Melbourne" },
    });
    expect(body.recurrence).toHaveLength(2);
  });
});

describe("eventMatchesJob / instanceMatchesJob", () => {
  const job = daily("2026-10-02", "2026-10-06");

  it("a master as Google returns it (offset form, reordered RRULE) matches the job", () => {
    expect(
      eventMatchesJob(
        {
          start: { dateTime: "2026-10-02T07:00:00+10:00" },
          end: { dateTime: "2026-10-02T15:30:00+10:00" },
          recurrence: [
            "EXDATE;TZID=Australia/Melbourne:20261004T070000,20261003T070000",
            "RRULE:UNTIL=20261005T200000Z;FREQ=DAILY",
          ],
        },
        job
      )
    ).toBe(true);
  });

  it("a master with a different rule does not match", () => {
    expect(
      eventMatchesJob(
        {
          start: { dateTime: "2026-10-02T07:00:00+10:00" },
          end: { dateTime: "2026-10-02T15:30:00+10:00" },
          recurrence: ["RRULE:FREQ=DAILY;COUNT=5"],
        },
        job
      )
    ).toBe(false);
  });

  it("an untouched occurrence matches; a moved or cancelled one does not", () => {
    const monday = {
      originalStartTime: { dateTime: "2026-10-05T07:00:00+11:00" },
      start: { dateTime: "2026-10-05T07:00:00+11:00" },
      end: { dateTime: "2026-10-05T15:30:00+11:00" },
    };
    expect(instanceMatchesJob(monday, job)).toBe(true);
    expect(instanceMatchesJob({ ...monday, start: { dateTime: "2026-10-05T09:00:00+11:00" } }, job)).toBe(false);
    expect(instanceMatchesJob({ ...monday, status: "cancelled" }, job)).toBe(false);
  });
});
