// POST /api/jobs/[id]/self-start — a technician starts work on a job they are
// not booked on (Justin, 25 Nov 2026). Request parsing and the fixed
// sentences the route answers with; the database function
// self_start_job_booking() (migration 0118) makes the decision and the row.
// Pure.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface SelfStartBody {
  /** The phone's id for the booking — a retry returns the same booking. */
  bookingId: string;
  /** The job's PO line (stage) they are working on. */
  costCenterId: string;
  /** The id the phone gives its clock-on; the booking follows that entry. */
  entryId: string;
}

export const SELF_START_SENTENCES = {
  badRequest: "Something was missing from the request. Try again.",
  notTechnician: "Only technicians can start work on a job this way.",
  notFound: "Job not found.",
  noStage: "Pick one of this job's cost centres.",
  stageDone: "That stage is already complete — pick another, or ask the office.",
  noStages: "This job has no open cost centre to clock on to. Ask the office to add one before you start.",
  notSwitchedOn: "Starting work on a job isn't switched on yet — ask the office to book you on.",
  conflict: "That booking isn't yours. Close the job and try again.",
  failed: "Couldn't start work on this job. Try again.",
  loadFailed: "Couldn't load the job's cost centres. Try again.",
} as const;

/** The sentence a closed job is refused with — 0096's own words. */
export function closedJobSentence(jobNumber: number | null | undefined, status: string): string {
  return `Job #${jobNumber ?? "?"} is ${status}. A ${status} job can't be scheduled — reopen it first.`;
}

export function parseSelfStartBody(body: unknown): SelfStartBody | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  const ids = [b.bookingId, b.costCenterId, b.entryId];
  if (!ids.every((v) => typeof v === "string" && UUID.test(v))) return null;
  return { bookingId: b.bookingId as string, costCenterId: b.costCenterId as string, entryId: b.entryId as string };
}

/**
 * The answer for an error from self_start_job_booking(). Its own codes
 * (MJ110–MJ115, MJ001) map to fixed sentences; anything else is a 500 with
 * a fixed sentence — the database's text never reaches the caller.
 */
export function selfStartRpcError(
  error: { code?: string; message?: string } | null | undefined,
  closed: { jobNumber: number | null; status: string } | null
): { status: number; error: string } {
  switch (error?.code) {
    case "42883":
    case "PGRST202":
      return { status: 409, error: SELF_START_SENTENCES.notSwitchedOn };
    case "MJ001":
      return { status: 400, error: closed ? closedJobSentence(closed.jobNumber, closed.status) : SELF_START_SENTENCES.failed };
    case "MJ110":
      return { status: 400, error: SELF_START_SENTENCES.badRequest };
    case "MJ111":
      return { status: 403, error: SELF_START_SENTENCES.notTechnician };
    case "MJ112":
      return { status: 409, error: SELF_START_SENTENCES.conflict };
    case "MJ113":
      return { status: 404, error: SELF_START_SENTENCES.notFound };
    case "MJ114":
      return { status: 400, error: SELF_START_SENTENCES.noStage };
    case "MJ115":
      return { status: 400, error: SELF_START_SENTENCES.stageDone };
    default:
      return { status: 500, error: SELF_START_SENTENCES.failed };
  }
}
