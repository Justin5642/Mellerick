import { describe, it, expect } from "vitest";
import {
  attendanceCandidateJobIds,
  bookedDayKeys,
  canFlagMissed,
  isMissingMissedColumn,
  isNotAttended,
  attendedKeys,
  missedDetailText,
  missedTagText,
  notAttendedBookings,
  notAttendedHeadline,
  validateMissed,
  withQueuedMissed,
  MISSED_REASONS,
  type AttendanceBooking,
} from "@/lib/booking-attendance";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Melbourne is UTC+11 in November (daylight time).
const T = "tech-1";
const JOB = "job-1";
const booking = (over: Partial<AttendanceBooking> = {}): AttendanceBooking => ({
  id: "b1",
  job_id: JOB,
  staff_id: T,
  // Mon 23 Nov 2026, 07:00–15:30 Melbourne
  starts_at: "2026-11-22T20:00:00Z",
  ends_at: "2026-11-23T04:30:00Z",
  daily: false,
  ...over,
});
const window = { todayKey: "2026-11-27", fromKey: "2026-09-28" };

describe("reasons", () => {
  it("are 0121's six keys, in order", () => {
    expect(MISSED_REASONS.map((r) => r.key)).toEqual(["out_of_time", "previous_job_ran_over", "site_not_ready", "weather", "unavailable", "other"]);
    const sql = readFileSync(join(process.cwd(), "supabase/migrations/0121_booking_missed.sql"), "utf8");
    for (const r of MISSED_REASONS) expect(sql).toContain(`'${r.key}'`);
  });

  it("validate", () => {
    expect(validateMissed({ reason: "weather" })).toEqual({ ok: true, reason: "weather", note: null });
    expect(validateMissed({ reason: "weather", note: "  wet  " })).toEqual({ ok: true, reason: "weather", note: "wet" });
    expect(validateMissed({ reason: "other" }).ok).toBe(false);
    expect(validateMissed({ reason: "other", note: "x" }).ok).toBe(true);
    expect(validateMissed({ reason: "nope" }).ok).toBe(false);
    expect(validateMissed({ reason: "weather", note: "x".repeat(501) }).ok).toBe(false);
    expect(validateMissed({ reason: "weather", note: 5 }).ok).toBe(false);
  });

  it("tag text", () => {
    expect(missedTagText({ missed_reason: "site_not_ready" })).toBe("Didn't make it — Site not ready / no access");
    expect(missedDetailText({ missed_reason: "other", missed_note: "truck broke down" })).toBe("Didn't make it — Other: truck broke down");
    expect(notAttendedHeadline(1)).toBe("1 booking not attended");
    expect(notAttendedHeadline(3)).toBe("3 bookings not attended");
  });
});

describe("day rules", () => {
  it("a daily Mon–Wed booking books three days", () => {
    expect(bookedDayKeys(booking({ ends_at: "2026-11-25T04:30:00Z", daily: true }))).toEqual(["2026-11-23", "2026-11-24", "2026-11-25"]);
  });

  it("can flag today's or an earlier booking on an open job, not a future one", () => {
    expect(canFlagMissed(booking(), "scheduled", "2026-11-23")).toBe(true);
    expect(canFlagMissed(booking(), "scheduled", "2026-11-27")).toBe(true);
    expect(canFlagMissed(booking(), "scheduled", "2026-11-22")).toBe(false);
    expect(canFlagMissed(booking(), "completed", "2026-11-27")).toBe(false);
    expect(canFlagMissed(booking({ staff_id: null }), "scheduled", "2026-11-27")).toBe(false);
    // Starts 07:00 Melbourne Mon = Sun 20:00 UTC: still Monday, not Sunday.
    expect(canFlagMissed(booking(), "scheduled", "2026-11-22")).toBe(false);
  });
});

describe("not attended", () => {
  const entry = (clock_in: string, over = {}) => ({ job_id: JOB, staff_id: T, clock_in, entry_type: "work", ...over });

  it("past, open, no work entry → not attended", () => {
    expect(isNotAttended(booking(), "scheduled", attendedKeys([]), window)).toBe(true);
  });

  it("a work clock-on that Melbourne day → attended", () => {
    // 06:30 Melbourne Monday = 19:30Z Sunday
    expect(isNotAttended(booking(), "scheduled", attendedKeys([entry("2026-11-22T19:30:00Z")]), window)).toBe(false);
  });

  it("travel, another day, another job or another person doesn't count", () => {
    for (const e of [
      entry("2026-11-22T19:30:00Z", { entry_type: "travel" }),
      entry("2026-11-24T01:00:00Z"),
      entry("2026-11-22T19:30:00Z", { job_id: "job-2" }),
      entry("2026-11-22T19:30:00Z", { staff_id: "tech-2" }),
    ]) {
      expect(isNotAttended(booking(), "scheduled", attendedKeys([e]), window)).toBe(true);
    }
  });

  it("any booked day of a multi-day booking counts", () => {
    const b = booking({ ends_at: "2026-11-25T04:30:00Z", daily: true });
    expect(isNotAttended(b, "scheduled", attendedKeys([entry("2026-11-24T01:00:00Z")]), window)).toBe(false);
  });

  it("not before its last day has passed", () => {
    const b = booking({ ends_at: "2026-11-27T04:30:00Z", daily: true });
    expect(isNotAttended(b, "scheduled", attendedKeys([]), window)).toBe(false);
  });

  it("never for a flagged booking, a closed job, an unassigned booking or one starting before the read window", () => {
    expect(isNotAttended(booking({ missed_reason: "weather" }), "scheduled", attendedKeys([]), window)).toBe(false);
    expect(isNotAttended(booking(), "completed", attendedKeys([]), window)).toBe(false);
    expect(isNotAttended(booking(), "cancelled", attendedKeys([]), window)).toBe(false);
    expect(isNotAttended(booking({ staff_id: null }), "scheduled", attendedKeys([]), window)).toBe(false);
    expect(isNotAttended(booking(), "scheduled", attendedKeys([]), { ...window, fromKey: "2026-11-24" })).toBe(false);
  });

  it("lists them newest first, and the jobs to read", () => {
    const older = booking({ id: "b0", starts_at: "2026-11-15T20:00:00Z", ends_at: "2026-11-16T04:30:00Z" });
    const list = notAttendedBookings([older, booking()], () => "scheduled", [], window);
    expect(list.map((i) => i.bookingId)).toEqual(["b1", "b0"]);
    expect(attendanceCandidateJobIds([older, booking({ job_id: "job-9", missed_reason: "weather" })], () => "scheduled", window)).toEqual([JOB]);
  });
});

describe("queued flags and missing columns", () => {
  it("lay a queued change over the server's", () => {
    const b = { missed_at: null, missed_reason: null, missed_note: null };
    expect(withQueuedMissed(b, undefined)).toBe(b);
    expect(withQueuedMissed(b, { reason: "weather", note: null }).missed_reason).toBe("weather");
    expect(withQueuedMissed({ ...b, missed_reason: "weather", missed_at: "x" }, null).missed_reason).toBeNull();
  });

  it("recognise 0121 not applied by code AND column", () => {
    expect(isMissingMissedColumn({ code: "42703", message: "column job_bookings_1.missed_at does not exist" })).toBe(true);
    expect(isMissingMissedColumn({ code: "PGRST204", message: "Could not find the 'missed_reason' column" })).toBe(true);
    expect(isMissingMissedColumn({ code: "42703", message: "column note does not exist" })).toBe(false);
    expect(isMissingMissedColumn({ code: "23505", message: "missed_at" })).toBe(false);
  });
});
