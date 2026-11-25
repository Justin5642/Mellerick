import { officeApi } from "./officeApi";
import type { StartStage } from "./selfStartBooking";

// "Start work on this job" (Justin, 25 Nov 2026): a technician on a job they
// are not booked on picks the stage and clocks on; the booking shows on the
// schedule straight away and ends when they clock off (migration 0118).
// ONLINE only — the booking (and so their place on the crew, which RLS needs
// before their clock-on can be written) must exist on the server first. Not
// the outbox. Calls the web's /api/jobs/[id]/self-start with the Bearer token.
// Names and ids only; the route never sends an amount.

export interface StartWorkJob {
  id: string;
  jobNumber: number | null;
  title: string | null;
  status: string;
  closed: boolean;
}

export interface StartWorkStages {
  job: StartWorkJob;
  stages: StartStage[];
  openCount: number;
}

export interface StartedBooking {
  id: string;
  job_id: string;
  staff_id: string | null;
  cost_center_id: string | null;
  starts_at: string;
  ends_at: string | null;
  daily: boolean;
  all_day: boolean;
  created_by: string | null;
}

export function loadStartStages(jobId: string): Promise<StartWorkStages> {
  return officeApi<StartWorkStages>(`/api/jobs/${jobId}/self-start`);
}

/**
 * Make the caller's booking. `bookingId` and `entryId` are the phone's own:
 * keep them for a retry of the same start, so a lost answer never makes a
 * second booking. Then clock on with `entryId` and the same cost centre.
 */
export function startWorkOnJob(
  jobId: string,
  input: { bookingId: string; costCenterId: string; entryId: string }
): Promise<{ booking: StartedBooking; stage: { id: string; name: string; costCentre: string | null } }> {
  return officeApi(`/api/jobs/${jobId}/self-start`, { method: "POST", body: input });
}
