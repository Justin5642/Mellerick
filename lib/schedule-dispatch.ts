// The one place the schedule board changes when a job is scheduled or
// reassigned — item 1.8.
//
// WHAT WENT WRONG WITHOUT IT. components/schedule/team-schedule-view.tsx wrote
// `scheduled_start`, `scheduled_end` and `assigned_to` straight to the jobs
// table and then called `toast.success`. Google Calendar was never told. Every
// other schedule-changing surface in the product does tell it — job creation,
// approvals, job overview, sign-off, and the whole mobile app, whose
// ScheduleRepository enqueues a coalesced sync-calendar after every job write.
// The board, whose entire purpose is moving jobs around, was the exception.
//
// A stale calendar is bad on its own. It was worse in combination: the poll in
// lib/google.ts read the untouched event and copied its OLD times back onto the
// job, so a background cron silently undid the drag in the database. That half
// is fixed there; this half stops the divergence arising in the first place.
//
// WHY BOTH DRAG KINDS PUSH, including assignment-only. The calendar event body
// (app/api/jobs/[id]/sync-calendar/route.ts) is built from the job number,
// title, description, customer, site and times — `assigned_to` appears nowhere,
// so today an assignment change genuinely cannot alter the event. Skipping the
// push on that basis would couple this file to the contents of a body assembled
// in a different file: the day someone adds the technician's name to the event
// summary, the board would quietly stop syncing again and nothing would say so.
// One extra no-op call per assignment drag is a cheap price for not encoding
// that invariant in two places.

/** The narrow slice of the Supabase client this module needs. */
export type ScheduleWriteClient = {
  from(table: string): {
    update(patch: Record<string, unknown>): {
      eq(column: string, value: string): PromiseLike<{ error: { message: string } | null }>;
    };
  };
};

/** Only the columns a drag can change. */
export type ScheduleChange = {
  assigned_to?: string | null;
  scheduled_start?: string | null;
  scheduled_end?: string | null;
};

export type ScheduleDispatchResult =
  /** The row changed. `calendarSynced` says whether Google heard about it. */
  | { ok: true; calendarSynced: boolean }
  /** The row did NOT change, and the caller must roll its optimistic state back. */
  | { ok: false; error: string };

/**
 * Apply a schedule or assignment change and push the job to Google Calendar.
 *
 * The two outcomes are kept apart on purpose. A refused write means nothing
 * happened: the caller has to restore its optimistic state, and Google must NOT
 * be told, or the calendar would hold a time the database rejected — which the
 * poll would later reconcile in the wrong direction.
 *
 * A successful write with a failed push is a different thing entirely: the job
 * really did move. Reporting that as a failure would be a lie that makes the
 * user drag it again. It is reported as success with `calendarSynced: false` so
 * the caller can say the one true thing — saved, calendar not updated.
 *
 * `fetchImpl` is injected so the seam is testable without a DOM.
 */
export async function applyScheduleChange(
  supabase: ScheduleWriteClient,
  jobId: string,
  patch: ScheduleChange,
  fetchImpl: typeof fetch = fetch
): Promise<ScheduleDispatchResult> {
  const { error } = await supabase.from("jobs").update(patch).eq("id", jobId);
  if (error) return { ok: false, error: error.message };

  try {
    const res = await fetchImpl(`/api/jobs/${jobId}/sync-calendar`, { method: "POST" });
    return { ok: true, calendarSynced: res.ok };
  } catch {
    // Offline, or the request never left. The row still changed.
    return { ok: true, calendarSynced: false };
  }
}
