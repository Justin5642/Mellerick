// How often the sync badge re-reads the outbox counts.
//
// It used to run its COUNT queries (pending + failed + inflight + dead) every
// 3 seconds for as long as the app was open — about 4,800 SQLite reads an hour
// on a phone whose queue is empty nearly all day.
//
// Now: counts are refreshed IMMEDIATELY on the events that change them
// (Outbox.onChange for enqueue / retry, SyncEngine.onSettled after each drain
// pass), polled quickly only while work is outstanding, and otherwise checked
// on a slow heartbeat that exists purely as a safety net for a change no event
// reported (a drain that threw before notifying, a dead-letter cascade).

/** While something is pending or retrying: the badge is counting down live. */
export const ACTIVE_POLL_MS = 3_000;
/** Nothing outstanding: a heartbeat, not a poll. */
export const IDLE_POLL_MS = 30_000;

export interface OutboxCounts {
  /** pending + failed (retrying) + inflight. */
  pending: number;
  /** Terminally dead — changes only via Retry (an event) or a cascade. */
  failed: number;
}

/**
 * Pure: delay until the next count refresh.
 *
 * Dead-only queues get the IDLE heartbeat: a dead op does not progress on its
 * own, and the only thing that revives one (Retry → retryDead) emits a change
 * event that triggers an immediate refresh.
 */
export function nextPollDelay(counts: OutboxCounts | null): number {
  if (counts === null) return ACTIVE_POLL_MS; // last read failed or none yet: retry soon
  return counts.pending > 0 ? ACTIVE_POLL_MS : IDLE_POLL_MS;
}
