/**
 * Never auto clock-on to a job that is already finished.
 *
 * Templestowe, 27 Nov 2026 (#2594): the job was signed off at 12:50; the
 * phone's own copy still had it open, and four minutes later — the technician
 * still inside the 150 m fence — the geofence clocked them straight back on
 * to a completed job, and the entry ran all afternoon.
 *
 * So before an AUTOMATIC clock-on the phone asks the server for the job's
 * live status (online only — offline it carries on as before, because the
 * mirror is all it has and losing a real visit is worse than this).
 *
 * The rule (pure):
 *   - open job → clock on;
 *   - completed / cancelled with no end time recorded → skip;
 *   - completed / cancelled, and the clock-on is at or after the job's end
 *     (`actual_end`, set by sign-off) → skip;
 *   - completed after the clock-on → clock on. That is real work done before
 *     sign-off whose clock-on only synced later (a queued background arrival
 *     from a dead zone) — dropping it would lose paid hours.
 */
export interface JobClosure {
  status: string | null;
  actualEnd: string | null;
}

const CLOSED = new Set(["completed", "cancelled"]);

export function skipAutoClockOn(job: JobClosure | null, clockInIso: string): boolean {
  if (!job || !job.status || !CLOSED.has(job.status)) return false;
  if (!job.actualEnd) return true;
  const end = Date.parse(job.actualEnd);
  const at = Date.parse(clockInIso);
  if (!Number.isFinite(end) || !Number.isFinite(at)) return true;
  return at >= end;
}
