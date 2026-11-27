// The phone's copy of lib/schedule-actuals.ts (pinned byte for byte by the
// web's tests/unit/schedule-actuals-mirror.test.ts; the rules are tested there).
// This checks the copy runs with the phone's own date/scheduling/bookings files.
import { actualLine, scheduleActuals } from "./scheduleActuals";

const mel = (local: string) => new Date(`${local}+11:00`).toISOString();

it("matches clocked time to the booking and flags the rest as not booked", () => {
  const a = scheduleActuals(
    [
      { id: "e1", job_id: "j1", staff_id: "dave", clock_in: mel("2026-11-24T07:42:00"), clock_out: mel("2026-11-24T15:10:00"), entry_type: "work" },
      { id: "e2", job_id: "j2", staff_id: "dave", clock_in: mel("2026-11-24T16:00:00"), clock_out: mel("2026-11-24T17:00:00"), entry_type: "work" },
    ],
    [{ id: "b1", job_id: "j1", staff_id: "dave", starts_at: mel("2026-11-24T07:00:00"), ends_at: mel("2026-11-24T15:30:00"), daily: false }],
    Date.parse(mel("2026-11-27T12:00:00")),
  );
  expect(actualLine(a.byBooking["b1|2026-11-24"])).toBe("Clocked 7:42–3:10 · 7.5 h");
  expect(a.unbooked["dave|2026-11-24"].map((s) => s.jobId)).toEqual(["j2"]);
  expect(a.clockedHours["dave|2026-11-24"]).toBeCloseTo(8.47, 2);
});
