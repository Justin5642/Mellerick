// "Schedule an existing job" from the schedule board (Justin's notebook list,
// 20 Nov 2026). The board only offered "New job"; an office person who wanted
// to book a job that already exists had to leave the board, find the job and
// press Schedule. Now: search open jobs (number, title, customer) from the
// board, pick one, and its Schedule dialog opens — with the technician and
// day already filled in when it was started from a technician's day.
//
// Mirrored byte for byte below this header at
// mobile/lib/scheduleExistingJob.ts (tests/unit/schedule-existing-job.test.ts)
// — change this file first, then copy.

/** At most this many search results. */
export const SCHEDULE_SEARCH_LIMIT = 20;

/** The statuses a job can't be scheduled in (lib/job-schedulable.ts — 0096). */
export const UNSCHEDULABLE_STATUSES: readonly string[] = ["completed", "cancelled"];

/** What the search reads for each job — no money. */
export const SCHEDULE_SEARCH_COLUMNS = "id, job_number, title, status, scheduled_start, customers(name, company), sites(suburb)";

export interface SchedulePrefill {
  /** The technician whose day was clicked; null = Unassigned / not given. */
  staffId: string | null;
  /** YYYY-MM-DD (Melbourne) of the clicked day; null = not given. */
  dateKey: string | null;
}

/** The search box as a job number when it is one ("#123", "123"); otherwise null. */
export function scheduleJobNumberQuery(q: string): number | null {
  const m = q.trim().match(/^#?(\d{1,9})$/);
  return m ? Number(m[1]) : null;
}

/** Words of the search box, with characters that would break a PostgREST or() removed. */
export function scheduleSearchTokens(q: string): string[] {
  return q
    .replace(/[,()%*\\"]/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

/** Whether the box holds enough to search: two characters, or a job number. */
export function isScheduleSearchable(q: string): boolean {
  const term = q.trim();
  return term.length >= 2 || scheduleJobNumberQuery(term) !== null;
}

/** Whether a found job may be offered: open (not completed or cancelled). */
export function canScheduleExistingJob(job: { status: string | null | undefined }): boolean {
  return !UNSCHEDULABLE_STATUSES.includes(job.status ?? "");
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;

/** A real calendar day as YYYY-MM-DD, else false. */
function isDateKey(value: string): boolean {
  if (!DATE_KEY.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

/** The job page's link that opens its Schedule dialog, prefilled when given. */
export function scheduleExistingJobHref(jobId: string, prefill?: Partial<SchedulePrefill> | null): string {
  const params = new URLSearchParams({ schedule: "1" });
  if (prefill?.staffId && UUID.test(prefill.staffId)) params.set("tech", prefill.staffId);
  if (prefill?.dateKey && isDateKey(prefill.dateKey)) params.set("day", prefill.dateKey);
  return `/dashboard/jobs/${jobId}?${params.toString()}`;
}

/**
 * The prefill a Schedule dialog opens with, from `?tech=&day=`. A technician
 * not in `staffIds` (inactive, or not a real id) is dropped rather than
 * booked; a day that isn't a real date is dropped. Nothing usable → null.
 */
export function parseSchedulePrefill(
  tech: string | null | undefined,
  day: string | null | undefined,
  staffIds: readonly string[]
): SchedulePrefill | null {
  const staffId = tech && UUID.test(tech) && staffIds.includes(tech) ? tech : null;
  const dateKey = day && isDateKey(day) ? day : null;
  return staffId || dateKey ? { staffId, dateKey } : null;
}
