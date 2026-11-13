// Which jobs can be scheduled, and how a refusal reads.
//
// A completed or cancelled job is left off the schedule board (web
// /dashboard/schedule, the phone's Schedule tab) and its calendar events are
// removed, so a booking on one is saved and then never seen again. The UI
// stops offering it; migration 0096 (a draft, not applied yet) would make the
// database refuse it too, with SQLSTATE MJ001, from any route.
//
// Mirrored at mobile/lib/jobSchedulable.ts; tests/unit/job-schedulable.test.ts
// pins the two identical.

/** The statuses that take a job off the schedule board. */
export const CLOSED_JOB_STATUSES: readonly string[] = ["completed", "cancelled"];

/** The SQLSTATE the database uses for "this job is closed" (0096). */
export const JOB_CLOSED_ERRCODE = "MJ001";

export function isJobClosedForScheduling(status: string | null | undefined): boolean {
  return CLOSED_JOB_STATUSES.includes(status ?? "");
}

/** What the office is told instead of a Schedule button that would mislead them. */
export function closedJobScheduleMessage(status: string): string {
  return `This job is ${status.replace("_", " ")}. ${status === "cancelled" ? "Cancelled" : "Completed"} jobs can't be scheduled — they don't appear on the schedule. To book it again, reopen it first by changing its status.`;
}

/** Whether a write was refused because its job is closed. */
export function isJobClosedError(error: { code?: string | null; message?: string | null } | null | undefined): boolean {
  if (!error) return false;
  return error.code === JOB_CLOSED_ERRCODE || /can't be scheduled — reopen it first/.test(error.message ?? "");
}
