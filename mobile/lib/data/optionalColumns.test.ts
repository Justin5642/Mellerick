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

  it("drops job_photos.folder before 0116, so a queued photo still lands (under Other)", () => {
    const noFolder = { code: "PGRST204", message: "Could not find the 'folder' column of 'job_photos' in the schema cache" };
    expect(
      withoutMissingOptionalColumns("job_photos", { job_id: "j1", storage_path: "j1/p.jpg", folder: "r1" }, noFolder)
    ).toEqual({ job_id: "j1", storage_path: "j1/p.jpg" });
    // A folder-only move has nothing left: the gateway treats it as done.
    expect(withoutMissingOptionalColumns("job_photos", { folder: "r1" }, noFolder)).toEqual({});
    // job_documents.folder is not optional on the phone (it isn't written through the outbox).
    expect(withoutMissingOptionalColumns("job_documents", { folder: "r1" }, noFolder)).toBeNull();
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
