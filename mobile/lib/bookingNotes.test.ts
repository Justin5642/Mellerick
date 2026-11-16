import { bookingNotesToShow, lastBookedDayKey } from "./bookingNotes";
import { buildBookingWindow } from "./bookings";
import type { Booking } from "./bookings";

// Which scheduling notes head a job's Overview (migration 0109). Melbourne
// calendar: Mon 16 Nov 2026 … Fri 20 Nov.

const NOW = new Date("2026-11-17T02:00:00Z"); // Tue 17 Nov, 1 pm Melbourne

function booking(id: string, staff: string | null, start: string, end: string, note: string | null, allDay = false): Booking & { staff_name: string | null } {
  return {
    id,
    job_id: "j1",
    staff_id: staff,
    staff_name: staff ? staff.toUpperCase() : null,
    cost_center_id: null,
    ...buildBookingWindow({ startDateKey: start, endDateKey: end, startTime: "07:00", endTime: "15:30", allDay }),
    note,
  };
}

const daveYesterday = booking("b-past", "dave", "2026-11-16", "2026-11-16", "Old note: dig the trench");
const daveToday = booking("b-today", "dave", "2026-11-17", "2026-11-17", "Today: pressure test");
const daveThursday = booking("b-thu", "dave", "2026-11-19", "2026-11-19", "Thursday: fit-off");
const samToday = booking("b-sam", "sam", "2026-11-17", "2026-11-17", "Sam: bring the jetter");
const daveNoNote = booking("b-plain", "dave", "2026-11-18", "2026-11-18", "   ");
const all = [daveYesterday, daveToday, daveThursday, samToday, daveNoNote];

describe("bookingNotesToShow", () => {
  it("a technician sees only their own current and upcoming bookings' notes", () => {
    const shown = bookingNotesToShow(all, { userId: "dave", isOffice: false }, NOW);
    expect(shown.map((n) => n.bookingId)).toEqual(["b-today", "b-thu"]);
    expect(shown.every((n) => n.own && n.staffName === null)).toBe(true);
  });

  it("a past booking's note no longer shows — the note does not follow the job around", () => {
    const shown = bookingNotesToShow([daveYesterday], { userId: "dave", isOffice: false }, NOW);
    expect(shown).toEqual([]);
  });

  it("today's note still shows after knock-off (day-based, not the end instant)", () => {
    const evening = new Date("2026-11-17T09:00:00Z"); // 8 pm Melbourne
    expect(bookingNotesToShow([daveToday], { userId: "dave", isOffice: false }, evening)).toHaveLength(1);
  });

  it("a multi-day booking's note shows until its last day", () => {
    const monToWed = booking("b-multi", "dave", "2026-11-16", "2026-11-18", "All week: drainage", true);
    expect(bookingNotesToShow([monToWed], { userId: "dave", isOffice: false }, NOW)).toHaveLength(1);
    expect(bookingNotesToShow([monToWed], { userId: "dave", isOffice: false }, new Date("2026-11-19T02:00:00Z"))).toHaveLength(0);
  });

  it("office sees every booking's note, labelled with whose it is", () => {
    const shown = bookingNotesToShow(all, { userId: "olive", isOffice: true }, NOW);
    expect(shown.map((n) => [n.bookingId, n.staffName])).toEqual([
      ["b-today", "DAVE"],
      ["b-sam", "SAM"],
      ["b-thu", "DAVE"],
    ]);
    expect(shown[0].when).toMatch(/Tue 17 Nov/);
  });

  it("an unassigned booking's note is office-only", () => {
    const unassigned = booking("b-un", null, "2026-11-18", "2026-11-18", "Whoever goes: key in lockbox");
    expect(bookingNotesToShow([unassigned], { userId: "dave", isOffice: false }, NOW)).toEqual([]);
    expect(bookingNotesToShow([unassigned], { userId: "olive", isOffice: true }, NOW)[0].staffName).toBe("Unassigned");
  });

  it("no bookings (before 0079, or unreadable) or no notes → nothing", () => {
    expect(bookingNotesToShow(null, { userId: "dave", isOffice: false }, NOW)).toEqual([]);
    expect(bookingNotesToShow([daveNoNote], { userId: "dave", isOffice: true }, NOW)).toEqual([]);
    expect(bookingNotesToShow([{ ...daveToday, note: undefined }], { userId: "dave", isOffice: false }, NOW)).toEqual([]);
  });
});

describe("lastBookedDayKey", () => {
  it("is the booking's last Melbourne day", () => {
    expect(lastBookedDayKey(daveThursday)).toBe("2026-11-19");
  });
});
