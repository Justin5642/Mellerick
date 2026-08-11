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
    update(patch: Record<string, unknown>, options?: { count: "exact" }): {
      eq(
        column: string,
        value: string
      ): PromiseLike<{ error: { message: string } | null; count?: number | null }>;
    };
  };
};

/**
 * The columns a schedule change can touch.
 *
 * The other job columns are open because the job overview saves its whole form
 * — title, status, priority and the schedule — in one statement. Forcing the
 * schedule out into a second write to keep this type closed would make a
 * half-saved job reachable: one of the two writes can fail on its own.
 */
export type ScheduleChange = {
  assigned_to?: string | null;
  scheduled_start?: string | null;
  scheduled_end?: string | null;
  // The other job columns an editable form saves in the same statement.
  //
  // NAMED, not an open `[column: string]: unknown` index signature. That was
  // the first attempt, and it accepts `{ scheduled_strt: … }` — a typo'd column
  // silently sent to PostgREST, which is the class of defect this file exists
  // to stop. Listing them costs one line each and keeps the compiler useful.
  title?: string;
  description?: string | null;
  status?: string;
  priority?: string;
  job_type?: string;
  notes?: string | null;
  completion_notes?: string | null;
  customer_id?: string | null;
  site_id?: string | null;
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
  // `count: "exact"` because PostgREST returns no error for an UPDATE that
  // matched nothing — RLS filters the row out and the statement succeeds
  // against zero rows. Taken as success, the caller keeps its optimistic move
  // on screen and Google is handed a time the database does not hold.
  const { error, count } = await supabase
    .from("jobs")
    .update(patch, { count: "exact" })
    .eq("id", jobId);
  if (error) return { ok: false, error: error.message };
  if (count === 0) {
    return { ok: false, error: "That job could not be changed — it may have been deleted or reassigned." };
  }

  return { ok: true, calendarSynced: await pushJobToCalendar(jobId, fetchImpl) };
}

/**
 * Tell Google about a job, and say whether it listened.
 *
 * Separate from applyScheduleChange for the screens that change a job in a way
 * this module cannot express — sign-off completes it, an approval sends it back
 * — but that still have to push. The boolean exists so those callers stop
 * writing `.catch(() => {})`: a push that failed has to change what the user is
 * told, or a job quietly keeps an event nobody will look at again.
 */
export async function pushJobToCalendar(
  jobId: string,
  fetchImpl: typeof fetch = fetch
): Promise<boolean> {
  try {
    const res = await fetchImpl(`/api/jobs/${jobId}/sync-calendar`, { method: "POST" });
    return res.ok;
  } catch {
    // Offline, or the request never left. Whatever the caller wrote still stands.
    return false;
  }
}
