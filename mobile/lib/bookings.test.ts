import { fromBusinessInputValue } from "./date";
import {
  bookingAt,
  bookingColumns,
  bookingWindow,
  clockInCostCentre,
  mergePendingBookings,
  myJobEntries,
  splitMyJobEntries,
  type Booking,
} from "./bookings";
import { buildScheduleColumns, occupiesDay } from "./scheduling";

// Calendar: Mon 19 Oct 2026 … Fri 23 Oct (Melbourne, +11).
const at = (key: string, time: string) => fromBusinessInputValue(`${key}T${time}`);
const ms = (key: string, time: string) => new Date(at(key, time)).getTime();

let n = 0;
function booking(over: Partial<Booking> & Pick<Booking, "job_id">): Booking {
  n++;
  return {
    id: `b${n}`,
    staff_id: "dave",
    cost_center_id: null,
    starts_at: at("2026-10-19", "07:00"),
    ends_at: at("2026-10-19", "15:30"),
    daily: false,
    all_day: false,
    ...over,
  };
}

const job = (id: string, start: string | null = null, end: string | null = null, daily = false) => ({
  id,
  scheduled_start: start,
  scheduled_end: end,
  schedule_daily: daily,
});

describe("bookingWindow / bookingColumns", () => {
  it("round-trips the 0071 schedule shape, so every day rule applies to a booking", () => {
    const cols = buildScheduleColumns({ startDateKey: "2026-10-19", endDateKey: "2026-10-21", startTime: "", endTime: "", allDay: true });
    const b = booking({ job_id: "j", ...bookingColumns(cols) });
    expect(bookingWindow(b)).toEqual(cols);
    expect(occupiesDay(bookingWindow(b), "2026-10-20")).toBe(true);
    expect(occupiesDay(bookingWindow(b), "2026-10-22")).toBe(false);
  });
});

describe("myJobEntries", () => {
  it("one entry per own booking — a job booked twice for me shows twice, each with its cost centre", () => {
    const j = job("j1", at("2026-10-19", "07:00"), at("2026-10-22", "12:00"));
    const rough = booking({ job_id: "j1", cost_center_id: "rough" });
    const fit = booking({ job_id: "j1", cost_center_id: "fit", starts_at: at("2026-10-22", "08:00"), ends_at: at("2026-10-22", "12:00") });
    const sams = booking({ job_id: "j1", staff_id: "sam", cost_center_id: "rough" });
    const entries = myJobEntries([j], [rough, fit, sams], "dave", "2026-10-19");
    expect(entries.map((e) => [e.bookingId, e.costCenterId])).toEqual([
      [rough.id, "rough"],
      [fit.id, "fit"],
    ]);
    expect(entries[1].window.scheduled_start).toBe(fit.starts_at);
    expect(new Set(entries.map((e) => e.key)).size).toBe(2); // unique list keys
  });

  it("falls back to the job's own window with no bookings at all (null — table not there yet)", () => {
    const j = job("j1", at("2026-10-19", "07:00"), at("2026-10-19", "15:30"));
    const [e] = myJobEntries([j], null, "dave", "2026-10-19");
    expect(e).toMatchObject({ key: "j1", bookingId: null, costCenterId: null });
    expect(e.window).toEqual({ scheduled_start: j.scheduled_start, scheduled_end: j.scheduled_end, schedule_daily: false });
  });

  it("falls back to the job window when only other people are booked (a crew member not yet booked)", () => {
    const j = job("j1", at("2026-10-19", "07:00"), at("2026-10-19", "15:30"));
    const entries = myJobEntries([j], [booking({ job_id: "j1", staff_id: "sam" })], "dave", "2026-10-19");
    expect(entries).toHaveLength(1);
    expect(entries[0].bookingId).toBeNull();
  });

  it("drops finished bookings while a current one exists on the same job", () => {
    const past = booking({ job_id: "j1" }); // Mon 19
    const next = booking({ job_id: "j1", starts_at: at("2026-10-22", "08:00"), ends_at: at("2026-10-22", "12:00") });
    const entries = myJobEntries([job("j1")], [past, next], "dave", "2026-10-21");
    expect(entries.map((e) => e.bookingId)).toEqual([next.id]);
  });

  it("keeps the latest booking when all are past, so an open job never disappears", () => {
    const a = booking({ job_id: "j1" });
    const b = booking({ job_id: "j1", starts_at: at("2026-10-20", "07:00"), ends_at: at("2026-10-20", "15:30") });
    const entries = myJobEntries([job("j1")], [a, b], "dave", "2026-10-23");
    expect(entries.map((e) => e.bookingId)).toEqual([b.id]);
  });

  it("a daily booking is current until its last day", () => {
    const d = booking({ job_id: "j1", daily: true, starts_at: at("2026-10-19", "07:00"), ends_at: at("2026-10-21", "15:30") });
    const earlier = booking({ job_id: "j1", starts_at: at("2026-10-12", "07:00"), ends_at: at("2026-10-12", "15:30") });
    expect(myJobEntries([job("j1")], [earlier, d], "dave", "2026-10-21").map((e) => e.bookingId)).toEqual([d.id]);
  });
});

describe("splitMyJobEntries", () => {
  it("splits by the BOOKING's day and orders today by that day's start", () => {
    const j1 = job("j1");
    const j2 = job("j2");
    const late = booking({ job_id: "j1", starts_at: at("2026-10-19", "13:00"), ends_at: at("2026-10-19", "15:00") });
    const early = booking({ job_id: "j2", starts_at: at("2026-10-19", "07:00"), ends_at: at("2026-10-19", "11:00") });
    const thu = booking({ job_id: "j1", starts_at: at("2026-10-22", "07:00"), ends_at: at("2026-10-22", "11:00") });
    const { today, upcoming } = splitMyJobEntries(myJobEntries([j1, j2], [late, thu, early], "dave", "2026-10-19"), "2026-10-19");
    expect(today.map((e) => e.bookingId)).toEqual([early.id, late.id]);
    expect(upcoming.map((e) => e.bookingId)).toEqual([thu.id]);
  });

  it("puts past-dated open jobs in Earlier at the bottom, so the next job leads Upcoming", () => {
    const entries = myJobEntries(
      [
        job("old", at("2026-10-07", "07:00"), at("2026-10-07", "15:00")),
        job("older", at("2026-09-30", "07:00"), at("2026-09-30", "15:00")),
        job("next", at("2026-10-21", "07:00"), at("2026-10-21", "11:00")),
      ],
      [],
      "dave",
      "2026-10-19"
    );
    const { upcoming, earlier } = splitMyJobEntries(entries, "2026-10-19");
    expect(upcoming.map((e) => e.job.id)).toEqual(["next"]);
    expect(earlier.map((e) => e.job.id)).toEqual(["old", "older"]); // most recent first
  });

  it("a multi-day job still running today is Today, not Earlier", () => {
    const entries = myJobEntries([job("mw", at("2026-10-17", "07:00"), at("2026-10-21", "15:00"))], [], "dave", "2026-10-19");
    expect(splitMyJobEntries(entries, "2026-10-19").earlier).toHaveLength(0);
  });

  it("puts unscheduled entries last in Upcoming, keeping their order", () => {
    const entries = myJobEntries(
      [job("u1"), job("s1", at("2026-10-23", "07:00"), at("2026-10-23", "09:00")), job("u2")],
      [],
      "dave",
      "2026-10-19"
    );
    expect(splitMyJobEntries(entries, "2026-10-19").upcoming.map((e) => e.job.id)).toEqual(["s1", "u1", "u2"]);
  });
});

describe("bookingAt / clockInCostCentre", () => {
  const morning = booking({ job_id: "j1", cost_center_id: "rough", starts_at: at("2026-10-19", "07:00"), ends_at: at("2026-10-19", "11:00") });
  const afternoon = booking({ job_id: "j1", cost_center_id: "fit", starts_at: at("2026-10-19", "12:00"), ends_at: at("2026-10-19", "15:30") });

  it("picks the booking covering the clock-in", () => {
    expect(clockInCostCentre([morning, afternoon], ms("2026-10-19", "13:00"), "job-cc")).toBe("fit");
    expect(clockInCostCentre([morning, afternoon], ms("2026-10-19", "07:00"), "job-cc")).toBe("rough");
  });

  it("else the nearest booking that day (early arrival, lunch gap, staying late)", () => {
    expect(clockInCostCentre([morning, afternoon], ms("2026-10-19", "06:40"), null)).toBe("rough");
    expect(clockInCostCentre([morning, afternoon], ms("2026-10-19", "11:20"), null)).toBe("rough");
    expect(clockInCostCentre([morning, afternoon], ms("2026-10-19", "11:45"), null)).toBe("fit");
    expect(clockInCostCentre([morning, afternoon], ms("2026-10-19", "17:00"), null)).toBe("fit");
  });

  it("else the job-level cost centre (no booking that day, or no bookings at all)", () => {
    expect(clockInCostCentre([morning], ms("2026-10-20", "08:00"), "job-cc")).toBe("job-cc");
    expect(clockInCostCentre([], ms("2026-10-20", "08:00"), "job-cc")).toBe("job-cc");
    expect(clockInCostCentre(null, ms("2026-10-20", "08:00"), "job-cc")).toBe("job-cc");
    expect(clockInCostCentre(undefined, ms("2026-10-20", "08:00"), undefined)).toBeNull();
  });

  it("a daily booking covers its hours on each booked day, not the night between", () => {
    const daily = booking({ job_id: "j1", cost_center_id: "rough", daily: true, starts_at: at("2026-10-19", "07:00"), ends_at: at("2026-10-21", "15:30") });
    expect(bookingAt([daily], ms("2026-10-20", "09:00"))).toBe(daily);
    // 22:00 Tuesday: no block covers it, but Tuesday's block is the nearest that day.
    expect(bookingAt([daily], ms("2026-10-20", "22:00"))).toBe(daily);
    expect(bookingAt([daily], ms("2026-10-22", "09:00"))).toBeNull();
  });

  it("a chosen booking without a cost centre falls through to the job level", () => {
    const none = booking({ job_id: "j1", cost_center_id: null });
    expect(clockInCostCentre([none], ms("2026-10-19", "09:00"), "job-cc")).toBe("job-cc");
  });
});

describe("mergePendingBookings", () => {
  const a = booking({ job_id: "j", starts_at: at("2026-10-19", "07:00") });
  const b = booking({ job_id: "j", starts_at: at("2026-10-20", "07:00") });
  const c = booking({ job_id: "j", starts_at: at("2026-10-21", "07:00") });

  it("keeps a queued insert the read does not have yet", () => {
    expect(mergePendingBookings([a, c], [a], new Set([c.id]))).toEqual([a, c]);
  });

  it("keeps the screen's version of a queued edit", () => {
    const edited = { ...a, cost_center_id: "new" };
    expect(mergePendingBookings([edited], [a], new Set([a.id]))).toEqual([edited]);
  });

  it("keeps a queued delete deleted", () => {
    expect(mergePendingBookings([a], [a, b], new Set([b.id]))).toEqual([a]);
  });

  it("lets the read win for anything not pending (a synced insert, someone else's change)", () => {
    const changedElsewhere = { ...a, cost_center_id: "web" };
    expect(mergePendingBookings([a], [changedElsewhere, b], new Set())).toEqual([changedElsewhere, b]);
  });
});

describe("arrivalCostCentre (geofence auto clock-in)", () => {
  it("uses the site's bookings at the arrival time, else the job level, and tolerates an old context", () => {
    // Imported lazily so this file stays free of the geofence module's other imports.
    const { arrivalCostCentre } = require("./geofenceState") as typeof import("./geofenceState");
    const b = booking({ job_id: "j1", cost_center_id: "rough" });
    const site = { jobId: "j1", lat: 0, lng: 0, scheduledCostCenterId: "job-cc", bookings: [b] };
    expect(arrivalCostCentre(site, ms("2026-10-19", "08:00"))).toBe("rough");
    expect(arrivalCostCentre(site, ms("2026-10-20", "08:00"))).toBe("job-cc");
    // Published by build 15: no `bookings` field at all.
    expect(arrivalCostCentre({ jobId: "j1", lat: 0, lng: 0, scheduledCostCenterId: "job-cc" }, ms("2026-10-19", "08:00"))).toBe("job-cc");
    expect(arrivalCostCentre(undefined, 0)).toBeNull();
  });
});
