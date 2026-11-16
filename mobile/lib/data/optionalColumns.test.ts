import { withoutMissingOptionalColumns } from "./optionalColumns";

// A queued booking write carrying `note` before 0109 is applied must still land
// (without the note) rather than dead-letter the booking itself.
describe("withoutMissingOptionalColumns", () => {
  const missing = { code: "PGRST204", message: "Could not find the 'note' column of 'job_bookings' in the schema cache" };

  it("drops job_bookings.note when the server says it is missing", () => {
    expect(withoutMissingOptionalColumns("job_bookings", { staff_id: "dave", note: "Hi" }, missing)).toEqual({ staff_id: "dave" });
    expect(
      withoutMissingOptionalColumns("job_bookings", { note: "Hi" }, { code: "42703", message: 'column "note" of relation "job_bookings" does not exist' })
    ).toEqual({});
  });

  it("leaves every other failure alone", () => {
    expect(withoutMissingOptionalColumns("job_bookings", { note: "Hi" }, null)).toBeNull();
    expect(withoutMissingOptionalColumns("job_bookings", { note: "Hi" }, { code: "42501", message: "note" })).toBeNull();
    // A different missing column is real drift — not swallowed.
    expect(
      withoutMissingOptionalColumns("job_bookings", { note: "Hi", colour: "red" }, { code: "PGRST204", message: "Could not find the 'colour' column" })
    ).toBeNull();
    // Another table's `note` is not optional.
    expect(withoutMissingOptionalColumns("jobs", { note: "Hi" }, missing)).toBeNull();
    // Nothing to drop when the payload never had it.
    expect(withoutMissingOptionalColumns("job_bookings", { staff_id: "dave" }, missing)).toBeNull();
  });
});
