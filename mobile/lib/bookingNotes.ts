// Which scheduling notes the job's Overview banner shows (migration 0109, a draft).
//
// Justin, 16 Nov 2026: "When we schedule people and we have a schedule note,
// that note needs to be just for that schedule and not carry on every time the
// job is opened." So a note lives on the booking it was written for
// (job_bookings.note), and is shown only while that booking is current or
// still to come: its last booked Melbourne day is today or later. Day-based on
// purpose — a technician looking the job up after knock-off still sees today's
// note — and it compares Melbourne date keys, never a stored instant against a
// later device clock read (HANDOVER §3, "the device clock lies").
//
// Who sees which: a technician only the notes on their OWN bookings (a note
// for Sam's Thursday fit-off is not Dave's instruction); office/admin every
// booking's, labelled with whose it is. The job_notes copy (source 'schedule')
// stays in Notes & Activity as history and is never shown here any more.
import { bookingWindow, type Booking } from "./bookings";
import { scheduleDays } from "./scheduling";
import { businessTodayKey, formatScheduleSummary } from "./scheduleDisplay";

export interface BookingNoteToShow {
  bookingId: string;
  note: string;
  /** "Wed 21 Oct, 7:00–15:30" — the booking's own days and hours. */
  when: string;
  /** Whose booking — null for the viewer's own (and for a technician, always their own). */
  staffName: string | null;
  /** True when the booking is the viewer's. */
  own: boolean;
}

/** The last Melbourne day a booking occupies ("YYYY-MM-DD"), or null for no days. */
export function lastBookedDayKey(b: Pick<Booking, "starts_at" | "ends_at" | "daily" | "all_day">): string | null {
  const days = scheduleDays(bookingWindow(b));
  return days.length > 0 ? days[days.length - 1].dateKey : null;
}

export function bookingNotesToShow(
  bookings: readonly (Booking & { staff_name?: string | null })[] | null | undefined,
  viewer: { userId: string | null; isOffice: boolean },
  now: Date = new Date()
): BookingNoteToShow[] {
  if (!bookings) return [];
  const today = businessTodayKey(now);
  return bookings
    .filter((b) => {
      const note = (b.note ?? "").trim();
      if (!note) return false;
      const own = !!viewer.userId && b.staff_id === viewer.userId;
      if (!own && !viewer.isOffice) return false;
      const last = lastBookedDayKey(b);
      return last !== null && last >= today;
    })
    .sort((a, b) => a.starts_at.localeCompare(b.starts_at))
    .map((b) => {
      const own = !!viewer.userId && b.staff_id === viewer.userId;
      return {
        bookingId: b.id,
        note: (b.note ?? "").trim(),
        when: formatScheduleSummary(bookingWindow(b)) ?? "",
        staffName: own ? null : b.staff_name ?? (b.staff_id ? "Technician" : "Unassigned"),
        own,
      };
    });
}
