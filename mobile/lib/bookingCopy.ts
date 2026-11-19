import { planBoardAdd, type BoardBooking } from "./boardModel";
import type { ScheduleWindowColumns } from "./bookings";
import { shiftDateKey } from "./date";
import { closedJobScheduleMessage, isJobClosedForScheduling } from "./jobSchedulable";
import { LEGACY_BOOKING_PREFIX } from "./scheduleGrid";

// "Copy to…" on a booking in the phone's Schedule tab (19 Nov 2026) — the
// web board's Shift-drop / Shift-paste. Jobs are often done in pairs; this
// adds a booking for another technician (and/or another day) that copies the
// tapped one — same cost centre, note, hours and shape — through
// ScheduleRepository.addBookings and the outbox, like every other booking
// write on the phone. The copy itself is planned by planBoardAdd, the mirror
// of the web's (lib/boardModel.ts ≡ components/schedule/board-model.ts):
// same day → the same window; another day → it STARTS there, keeping its shape.
//
// Same guards as a move: never on a closed job (0096 refuses it anyway) or a
// stand-in row with no real booking; the caller then warns — never blocks —
// on a clash and on the technician's leave (0112), with "Book anyway".

export type CopyPlan =
  | {
      ok: true;
      /** What addBookings writes. */
      staffId: string;
      columns: ScheduleWindowColumns;
      costCenterId: string | null;
      note: string | null;
      /** The copy as a board booking, for the clash and leave checks. */
      after: BoardBooking;
    }
  | { ok: false; reason: string };

export function planBookingCopy(
  job: { status: string },
  booking: BoardBooking,
  sourceKey: string,
  target: { staffId: string | null; dateKey: string },
  jobBookings: readonly BoardBooking[],
  targetName = "That technician",
): CopyPlan {
  if (isJobClosedForScheduling(job.status)) return { ok: false, reason: closedJobScheduleMessage(job.status) };
  if (booking.id.startsWith(LEGACY_BOOKING_PREFIX)) {
    return { ok: false, reason: "This job has no bookings yet. Use Reschedule from its menu, or Schedule on the job." };
  }
  if (!target.staffId) return { ok: false, reason: "Pick the technician to copy the booking to." };
  const insert = planBoardAdd(booking, { staffId: booking.staff_id, dateKey: sourceKey }, target, jobBookings);
  if (!insert || !insert.staff_id) {
    return { ok: false, reason: `${targetName} already has this booking then — nothing to copy.` };
  }
  return {
    ok: true,
    staffId: insert.staff_id,
    columns: {
      scheduled_start: insert.starts_at,
      scheduled_end: insert.ends_at,
      schedule_daily: insert.daily,
      schedule_all_day: insert.all_day,
    },
    costCenterId: insert.cost_center_id,
    note: insert.note ?? null,
    after: {
      ...booking,
      id: `copy-of:${booking.id}`,
      staff_id: insert.staff_id,
      starts_at: insert.starts_at,
      ends_at: insert.ends_at,
      daily: insert.daily,
      all_day: insert.all_day,
      note: insert.note ?? null,
    },
  };
}

/** The days offered as a copy's start: the tapped day (or today, if that has passed) and the 13 after it. */
export function copyDayChoices(sourceKey: string, todayKey: string, count = 14): string[] {
  const first = sourceKey >= todayKey ? sourceKey : todayKey;
  return Array.from({ length: count }, (_, i) => shiftDateKey(first, i));
}
