import { describe, it, expect } from "vitest";
import {
  bookingScheduleInput,
  bookingsFromJobWindow,
  buildBookingWindow,
  describeBooking,
  isBookingsTableMissing,
  planBookingSave,
  type BookingDraft,
  type JobBooking,
} from "@/lib/bookings";
import { fromBusinessInputValue } from "@/lib/date";

// ============================================================================
// lib/bookings.ts — the web's rules for job bookings (job_bookings, migration
// 0079: a draft, not applied yet). A booking's window means what a job's did
// under 0071, so these tests pin the TRANSLATION, not the day rules (those are
// tests/unit/scheduling-multiday.test.ts).
//
// The dialog's save is the part with teeth: a row of several technicians
// becomes one booking each; an edited row updates its saved booking IN PLACE
// (keeping its calendar event); a removed row deletes its booking.
//
// Calendar (Melbourne): Mon 19 Oct 2026 … Fri 23.
// ============================================================================

const at = (key: string, time: string) => fromBusinessInputValue(`${key}T${time}`);

const allDayMonTue = { startDateKey: "2026-10-19", endDateKey: "2026-10-20", startTime: "07:00", endTime: "15:30", allDay: true };
const monMorning = { startDateKey: "2026-10-19", endDateKey: "2026-10-19", startTime: "07:00", endTime: "11:00", allDay: false };

function saved(overrides: Partial<JobBooking> = {}): JobBooking {
  return {
    id: "b-dave",
    job_id: "job-1",
    staff_id: "dave",
    cost_center_id: "cc-rough",
    ...buildBookingWindow(allDayMonTue),
    ...overrides,
  };
}

describe("booking windows reuse lib/scheduling.ts", () => {
  it("a Mon–Tue all-day row is a daily 7:00–15:30 booking", () => {
    expect(buildBookingWindow(allDayMonTue)).toEqual({
      starts_at: at("2026-10-19", "07:00"),
      ends_at: at("2026-10-20", "15:30"),
      daily: true,
      all_day: true,
    });
  });

  it("round-trips through the dialog's input", () => {
    expect(bookingScheduleInput(buildBookingWindow(allDayMonTue))).toEqual(allDayMonTue);
    expect(bookingScheduleInput(buildBookingWindow(monMorning))).toEqual(monMorning);
  });

  it("describes a booking the way a job's schedule is described", () => {
    expect(describeBooking(buildBookingWindow(monMorning))).toBe("Booked Mon 19 Oct, 7:00–11:00 (4 h)");
  });
});

describe("planBookingSave — the Schedule dialog's rows become writes", () => {
  it("a new row with two technicians is two bookings on the same window and cost centre", () => {
    const rows: BookingDraft[] = [{ staffIds: ["dave", "sam"], costCenterId: "cc-rough", schedule: allDayMonTue }];
    const plan = planBookingSave("job-1", [], rows);
    expect(plan.updates).toEqual([]);
    expect(plan.deletes).toEqual([]);
    expect(plan.inserts).toEqual([
      { job_id: "job-1", staff_id: "dave", cost_center_id: "cc-rough", ...buildBookingWindow(allDayMonTue) },
      { job_id: "job-1", staff_id: "sam", cost_center_id: "cc-rough", ...buildBookingWindow(allDayMonTue) },
    ]);
  });

  it("a row with nobody picked is one unassigned booking", () => {
    const plan = planBookingSave("job-1", [], [{ staffIds: [], costCenterId: null, schedule: monMorning }]);
    expect(plan.inserts).toEqual([{ job_id: "job-1", staff_id: null, cost_center_id: null, ...buildBookingWindow(monMorning) }]);
  });

  it("an untouched saved row writes nothing", () => {
    const b = saved();
    const plan = planBookingSave("job-1", [b], [{ bookingId: b.id, staffIds: ["dave"], costCenterId: "cc-rough", schedule: allDayMonTue }]);
    expect(plan).toEqual({ inserts: [], updates: [], deletes: [] });
  });

  it("an edited saved row is updated in place, only in the columns that changed", () => {
    const b = saved();
    const plan = planBookingSave("job-1", [b], [{ bookingId: b.id, staffIds: ["dave"], costCenterId: "cc-fit", schedule: monMorning }]);
    expect(plan.inserts).toEqual([]);
    expect(plan.updates).toEqual([{ id: "b-dave", patch: { cost_center_id: "cc-fit", ...buildBookingWindow(monMorning) } }]);
  });

  it("adding Sam to Dave's row keeps Dave's booking and inserts Sam's — even when Sam is picked first", () => {
    const b = saved();
    const plan = planBookingSave("job-1", [b], [{ bookingId: b.id, staffIds: ["sam", "dave"], costCenterId: "cc-rough", schedule: allDayMonTue }]);
    expect(plan.updates).toEqual([]);
    expect(plan.inserts.map((i) => i.staff_id)).toEqual(["sam"]);
  });

  it("swapping the technician on a saved row hands that booking over", () => {
    const b = saved();
    const plan = planBookingSave("job-1", [b], [{ bookingId: b.id, staffIds: ["sam"], costCenterId: "cc-rough", schedule: allDayMonTue }]);
    expect(plan.updates).toEqual([{ id: "b-dave", patch: { staff_id: "sam" } }]);
  });

  it("clearing every technician from a saved row unassigns it", () => {
    const b = saved();
    const plan = planBookingSave("job-1", [b], [{ bookingId: b.id, staffIds: [], costCenterId: "cc-rough", schedule: allDayMonTue }]);
    expect(plan.updates).toEqual([{ id: "b-dave", patch: { staff_id: null } }]);
  });

  it("a removed row deletes its booking", () => {
    const keep = saved();
    const gone = saved({ id: "b-sam", staff_id: "sam" });
    const plan = planBookingSave("job-1", [keep, gone], [{ bookingId: keep.id, staffIds: ["dave"], costCenterId: "cc-rough", schedule: allDayMonTue }]);
    expect(plan.deletes).toEqual(["b-sam"]);
  });

  it("treats a saved window as unchanged when only its string form differs", () => {
    // PostgREST hands back "+00:00" where the client wrote ".000Z".
    const b = saved();
    const reformatted = { ...b, starts_at: b.starts_at.replace(".000Z", "+00:00"), ends_at: b.ends_at!.replace(".000Z", "+00:00") };
    const plan = planBookingSave("job-1", [reformatted], [{ bookingId: b.id, staffIds: ["dave"], costCenterId: "cc-rough", schedule: allDayMonTue }]);
    expect(plan.updates).toEqual([]);
  });
});

describe("before job_bookings exists (0079 is a draft, not applied)", () => {
  it("recognises PostgREST's answers for a missing table or embed", () => {
    expect(isBookingsTableMissing({ code: "42P01" })).toBe(true);
    expect(isBookingsTableMissing({ code: "PGRST205" })).toBe(true);
    expect(isBookingsTableMissing({ code: "PGRST200" })).toBe(true);
    expect(isBookingsTableMissing({ code: "42501" })).toBe(false);
    expect(isBookingsTableMissing(null)).toBe(false);
  });

  it("derives one booking per crew member on the job's window, as the migration's conversion would", () => {
    const job = {
      id: "job-1",
      scheduled_start: at("2026-10-19", "07:00"),
      scheduled_end: at("2026-10-20", "15:30"),
      schedule_daily: true,
      schedule_all_day: true,
      scheduled_cost_center_id: "cc-rough",
    };
    const derived = bookingsFromJobWindow(job, ["dave", "sam"]);
    expect(derived.map((b) => b.staff_id)).toEqual(["dave", "sam"]);
    expect(derived[0]).toMatchObject({ job_id: "job-1", cost_center_id: "cc-rough", daily: true, all_day: true });
    expect(bookingsFromJobWindow(job, [])).toHaveLength(1);
    expect(bookingsFromJobWindow(job, [])[0].staff_id).toBeNull();
    expect(bookingsFromJobWindow({ ...job, scheduled_start: null }, ["dave"])).toEqual([]);
  });
});
