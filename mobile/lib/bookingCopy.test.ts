import { copyDayChoices, planBookingCopy } from "./bookingCopy";
import type { BoardBooking } from "./boardModel";

// "Copy to…" on the phone Schedule = the web board's Shift-drop, through the
// mirrored planBoardAdd. Melbourne: Thu 20 Nov 2026 07:00 = 2026-11-19T20:00Z.
const dave: BoardBooking = {
  id: "bk-1",
  job_id: "job-1",
  staff_id: "dave",
  cost_center_id: "cc-drain",
  starts_at: "2026-11-19T20:00:00Z",
  ends_at: "2026-11-20T04:30:00Z",
  daily: false,
  all_day: true,
  note: "Bring the jetter",
};
const OPEN = { status: "scheduled" };

describe("planBookingCopy", () => {
  it("same day: the same window, cost centre and note for the other technician", () => {
    const plan = planBookingCopy(OPEN, dave, "2026-11-20", { staffId: "sam", dateKey: "2026-11-20" }, [dave]);
    expect(plan).toMatchObject({
      ok: true,
      staffId: "sam",
      costCenterId: "cc-drain",
      note: "Bring the jetter",
      columns: { scheduled_start: dave.starts_at, scheduled_end: dave.ends_at, schedule_daily: false, schedule_all_day: true },
    });
    if (plan.ok) expect(plan.after).toMatchObject({ staff_id: "sam", starts_at: dave.starts_at });
  });

  it("another day: the copy STARTS there, keeping its hours", () => {
    const plan = planBookingCopy(OPEN, dave, "2026-11-20", { staffId: "sam", dateKey: "2026-11-24" }, [dave]);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.columns.scheduled_start).toBe("2026-11-23T20:00:00.000Z"); // Mon 24 Nov 07:00 Melbourne
    expect(new Date(plan.columns.scheduled_end as string).getTime() - new Date(plan.columns.scheduled_start).getTime()).toBe(8.5 * 3600_000);
  });

  it("refuses a copy that already exists (same tech, window and cost centre)", () => {
    const plan = planBookingCopy(OPEN, dave, "2026-11-20", { staffId: "dave", dateKey: "2026-11-20" }, [dave], "Dave");
    expect(plan).toEqual({ ok: false, reason: "Dave already has this booking then — nothing to copy." });
  });

  it("refuses a closed job, a stand-in row and no technician", () => {
    expect(planBookingCopy({ status: "completed" }, dave, "2026-11-20", { staffId: "sam", dateKey: "2026-11-20" }, [dave])).toMatchObject({ ok: false, reason: expect.stringMatching(/can't be scheduled/) });
    expect(planBookingCopy(OPEN, { ...dave, id: "legacy:job-1" }, "2026-11-20", { staffId: "sam", dateKey: "2026-11-20" }, [])).toMatchObject({ ok: false, reason: expect.stringMatching(/no bookings yet/) });
    expect(planBookingCopy(OPEN, dave, "2026-11-20", { staffId: null, dateKey: "2026-11-20" }, [dave])).toMatchObject({ ok: false, reason: expect.stringMatching(/Pick the technician/) });
  });
});

describe("copyDayChoices", () => {
  it("starts on the tapped day, or today once that has passed", () => {
    expect(copyDayChoices("2026-11-24", "2026-11-19", 3)).toEqual(["2026-11-24", "2026-11-25", "2026-11-26"]);
    expect(copyDayChoices("2026-11-10", "2026-11-19", 2)).toEqual(["2026-11-19", "2026-11-20"]);
  });
});
