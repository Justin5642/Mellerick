import { describe, it, expect } from "vitest";
import {
  buildBookingWindow,
  insertBookings,
  isMissingNoteColumn,
  normaliseBookingNote,
  planBookingSave,
  scheduleNotesToLog,
  updateBooking,
  type BookingDraft,
  type BookingWriteClient,
  type JobBooking,
} from "@/lib/bookings";
import { planBoardAdd, type BoardBooking } from "@/components/schedule/board-model";

// ============================================================================
// Scheduling notes belong to a booking (job_bookings.note, migration 0109 —
// a DRAFT until applied). Justin, 16 Nov 2026: "that note needs to be just for
// that schedule and not carry on every time the job is opened."
//
// Pinned here: the dialog writes each row's note onto its booking(s) and only
// when it changed; the job_notes history copy is posted only for a new or
// changed note; the board's Shift-copy carries the note; and on a database
// without 0109 every write still lands (without its note) instead of failing.
// ============================================================================

const monTue = { startDateKey: "2026-10-19", endDateKey: "2026-10-20", startTime: "07:00", endTime: "15:30", allDay: true };

function saved(overrides: Partial<JobBooking> = {}): JobBooking {
  return { id: "b-dave", job_id: "job-1", staff_id: "dave", cost_center_id: null, ...buildBookingWindow(monTue), ...overrides };
}

function row(overrides: Partial<BookingDraft> = {}): BookingDraft {
  return { staffIds: ["dave"], costCenterId: null, schedule: monTue, ...overrides };
}

describe("normaliseBookingNote", () => {
  it("trims, and blank is no note", () => {
    expect(normaliseBookingNote("  Bring the jetter ")).toBe("Bring the jetter");
    expect(normaliseBookingNote("   ")).toBeNull();
    expect(normaliseBookingNote(undefined)).toBeNull();
  });
});

describe("planBookingSave carries each row's note", () => {
  it("a new row of two technicians puts the note on both bookings", () => {
    const plan = planBookingSave("job-1", [], [row({ staffIds: ["dave", "sam"], note: " Rough-in only " })]);
    expect(plan.inserts.map((i) => [i.staff_id, i.note])).toEqual([
      ["dave", "Rough-in only"],
      ["sam", "Rough-in only"],
    ]);
  });

  it("a new booking without a note never names the column (works before 0109)", () => {
    const plan = planBookingSave("job-1", [], [row({ note: "  " })]);
    expect("note" in plan.inserts[0]).toBe(false);
  });

  it("editing only the note updates that booking's note and nothing else", () => {
    const plan = planBookingSave("job-1", [saved({ note: "Old" })], [row({ bookingId: "b-dave", note: "New" })]);
    expect(plan.updates).toEqual([{ id: "b-dave", patch: { note: "New" } }]);
  });

  it("clearing a note writes null", () => {
    const plan = planBookingSave("job-1", [saved({ note: "Old" })], [row({ bookingId: "b-dave", note: "" })]);
    expect(plan.updates).toEqual([{ id: "b-dave", patch: { note: null } }]);
  });

  it("an unchanged note (whitespace aside) writes nothing", () => {
    const plan = planBookingSave("job-1", [saved({ note: "Same" })], [row({ bookingId: "b-dave", note: " Same " })]);
    expect(plan.updates).toEqual([]);
  });

  it("a booking read without the column (note undefined) and a blank row is unchanged", () => {
    const plan = planBookingSave("job-1", [saved()], [row({ bookingId: "b-dave", note: "" })]);
    expect(plan.updates).toEqual([]);
  });
});

describe("scheduleNotesToLog — the job_notes history copy", () => {
  it("posts a new booking's note once, however many technicians share it", () => {
    expect(scheduleNotesToLog([], [row({ note: "Pump out first" }), row({ staffIds: ["sam"], note: "Pump out first" })])).toEqual([
      "Pump out first",
    ]);
  });

  it("does not repeat an unchanged note when the booking is only moved", () => {
    expect(scheduleNotesToLog([saved({ note: "Pump out first" })], [row({ bookingId: "b-dave", note: "Pump out first" })])).toEqual([]);
  });

  it("posts an edited note", () => {
    expect(scheduleNotesToLog([saved({ note: "Old" })], [row({ bookingId: "b-dave", note: "New" })])).toEqual(["New"]);
  });

  it("posts nothing for rows without a note", () => {
    expect(scheduleNotesToLog([], [row()])).toEqual([]);
  });
});

describe("the board's Shift-copy keeps the note", () => {
  const booking: BoardBooking = { ...saved({ note: "Use the side gate" }), cost_center_name: null };
  const cell = { staffId: "dave", dateKey: "2026-10-19" };
  it("copies it to the new technician's booking", () => {
    expect(planBoardAdd(booking, cell, { staffId: "sam", dateKey: "2026-10-19" }, [booking])?.note).toBe("Use the side gate");
  });
  it("a booking without a note copies without the column", () => {
    const plain: BoardBooking = { ...saved(), cost_center_name: null };
    const copy = planBoardAdd(plain, cell, { staffId: "sam", dateKey: "2026-10-19" }, [plain]);
    expect(copy && "note" in copy).toBe(false);
  });
});

describe("before 0109 is applied", () => {
  const missingSelect = { code: "42703", message: "column job_bookings.note does not exist" };
  const missingBody = { code: "PGRST204", message: "Could not find the 'note' column of 'job_bookings' in the schema cache" };

  it("recognises the missing note column by code and name only", () => {
    expect(isMissingNoteColumn(missingSelect)).toBe(true);
    expect(isMissingNoteColumn(missingBody)).toBe(true);
    expect(isMissingNoteColumn({ code: "42703", message: "column job_bookings.notes_x does not exist" })).toBe(false);
    expect(isMissingNoteColumn({ code: "42501", message: "note" })).toBe(false);
    expect(isMissingNoteColumn(null)).toBe(false);
  });

  function fakeClient(firstError: { code: string; message: string } | null) {
    const inserts: unknown[] = [];
    const updates: unknown[] = [];
    const client = {
      from: () => ({
        insert: (rows: unknown) => {
          inserts.push(rows);
          return {
            select: async () =>
              inserts.length === 1 && firstError
                ? { data: null, error: firstError }
                : { data: (rows as unknown[]).map((r, i) => ({ ...(r as object), id: `new-${i}` })), error: null },
          };
        },
        update: (patch: unknown) => {
          updates.push(patch);
          return { eq: async () => (updates.length === 1 && firstError ? { error: firstError, count: null } : { error: null, count: 1 }) };
        },
        delete: () => ({ eq: async () => ({ error: null, count: 1 }) }),
      }),
    } as unknown as BookingWriteClient;
    return { client, inserts, updates };
  }

  it("an insert with a note is retried without it", async () => {
    const { client, inserts } = fakeClient(missingBody);
    const row = { job_id: "job-1", staff_id: "dave", cost_center_id: null, ...buildBookingWindow(monTue), note: "Hi" };
    const result = await insertBookings(client, [row]);
    expect(result.ok).toBe(true);
    expect(inserts).toHaveLength(2);
    expect((inserts[1] as object[])[0]).not.toHaveProperty("note");
  });

  it("an update is retried without the note; a note-only edit has nothing left and succeeds", async () => {
    const a = fakeClient(missingBody);
    expect(await updateBooking(a.client, "b-1", { staff_id: "sam", note: "Hi" })).toEqual({ ok: true });
    expect(a.updates[1]).toEqual({ staff_id: "sam" });

    const b = fakeClient(missingBody);
    expect(await updateBooking(b.client, "b-1", { note: "Hi" })).toEqual({ ok: true });
    expect(b.updates).toHaveLength(1);
  });

  it("an unrelated error is not swallowed", async () => {
    const { client, updates } = fakeClient({ code: "42501", message: "permission denied" });
    const result = await updateBooking(client, "b-1", { note: "Hi" });
    expect(result.ok).toBe(false);
    expect(updates).toHaveLength(1);
  });
});
