// Shared by the jobs list's server page (app/dashboard/jobs/page.tsx) and its
// client component (components/jobs/jobs-list-client.tsx).
//
// This MUST stay a plain module. These used to be exported from the "use client"
// component file, and a server component importing a value from a client
// module does not get the value — it gets a client reference. The server page
// then passed that reference to .select() as its column list, and the Jobs
// page showed nothing (18 Oct 2026). tests/unit/jobs-list-shared.test.ts pins it.

export const PAGE_SIZE = 50;
// Only what the list renders. The old select("*") pulled every column of
// every job (transcripts, notes, descriptions) for ~825+ jobs up front.
export const BASE_COLUMNS = "id, job_number, title, status, priority, scheduled_start, customers(name)";
// todo_listed_at drives the "To-do" badge. Until the to-do columns exist in the
// database PostgREST rejects the whole select with 42703 (undefined column), so
// the list retries once without it — the badge is optional, the list is not.
// scheduled_end + schedule_daily (0071) turn a multi-day job's date into its
// range; they ride the same retry, falling back to the start date alone.
export const LIST_COLUMNS = `${BASE_COLUMNS}, todo_listed_at, scheduled_end, schedule_daily`;

export type StageInfo = { stage: string; created_at: string };

/** job_id -> most recent stage note, from notes ordered newest first or not. */
export function latestStageByJob(
  notes: { job_id: string; stage: string; created_at: string | null }[],
  into = new Map<string, StageInfo>()
): Map<string, StageInfo> {
  for (const note of notes) {
    if (!note.created_at) continue;
    const existing = into.get(note.job_id);
    if (!existing || note.created_at > existing.created_at) into.set(note.job_id, { stage: note.stage, created_at: note.created_at });
  }
  return into;
}

