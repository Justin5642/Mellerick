import { describeOperation, explainError } from "./describe";
import type { Operation } from "./types";

const write = (table: string, op: "insert" | "update" | "delete", payload: Record<string, unknown> = {}): Operation =>
  ({ kind: "write", id: "o1", rowId: "r1", aggregate: "job", op, table, payload, status: "dead", attempts: 5, nextAttemptAt: 0, createdAt: 0 }) as unknown as Operation;

describe("describeOperation", () => {
  it("names the thing and what was being done to it", () => {
    expect(describeOperation(write("time_entries", "update"))).toBe("Change to a time entry");
    expect(describeOperation(write("job_photos", "insert"))).toBe("New photo");
    expect(describeOperation(write("job_notes", "delete"))).toBe("Deleting a job note");
    expect(describeOperation(write("jobs", "update", { notes: "x" }))).toBe("Change to a job");
  });
  it("recognises a job sign-off", () => {
    expect(describeOperation(write("jobs", "update", { status: "completed" }))).toBe("Completing a job");
  });
  it("labels background tasks", () => {
    const op = { kind: "side_effect", id: "s", effect: "sync-calendar", coalesceKey: "k", payload: {}, status: "dead", attempts: 5, nextAttemptAt: 0, createdAt: 0 } as unknown as Operation;
    expect(describeOperation(op)).toBe("Updating the calendar");
  });
  it("falls back to the table name for anything new", () => {
    expect(describeOperation(write("some_new_table", "insert"))).toBe("New some new table");
  });
});

describe("explainError", () => {
  it("translates the refusals the database is known to give", () => {
    expect(explainError("this time entry has been billed — ask the office to change it")).toMatch(/already billed/);
    expect(explainError('new row violates row-level security policy for table "time_entries"')).toMatch(/isn't allowed/);
    expect(explainError("Job #505 is completed. A completed job can't be scheduled — reopen it first.")).toMatch(/completed or cancelled/);
    expect(explainError('duplicate key value violates unique constraint "x"')).toMatch(/saved twice/);
    expect(explainError('new row for relation "time_entries" violates check constraint "time_entries_duration_sane"')).toMatch(/clock-off before/);
    expect(explainError("dependency failed")).toMatch(/earlier change/);
  });
  it("never hides an unknown reason behind a guess", () => {
    expect(explainError("something unexpected")).toBe("The server refused it.");
    expect(explainError(null)).toMatch(/without saying why/);
  });
});
