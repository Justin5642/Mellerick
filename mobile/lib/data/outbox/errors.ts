// Failure classification for the outbox.
//
// WHY THIS EXISTS. Every failure used to cost an attempt, and MAX_ATTEMPTS
// failures sent an operation to the terminal "dead" state. That budget exists to
// stop a POISON write (a payload the server will never accept) retrying
// forever — but a technician in a dead zone burns through it on nothing worse
// than "no signal": eight failed attempts span ~10 minutes of backoff, so a
// clock-out queued at the start of a 20-minute drive through the hills was
// dead-lettered before the van reached coverage, and stayed dead until someone
// noticed the badge and pressed Retry.
//
// So failures are split in two:
//
//   transient  the network, a timeout, or the server having a bad moment
//              (status 0, 408, 429, 5xx). Says nothing about the write itself.
//              Backed off, never counted toward MAX_ATTEMPTS, never dead.
//   rejection  the server looked at the write and refused it (any other 4xx:
//              RLS, a constraint, a malformed payload). Counted as before.
//
// When in doubt an error is a REJECTION: the cost of misclassifying a real
// rejection as transient is an operation that retries every five minutes
// forever (visible as "pending" on the badge), which is worse than the old
// behaviour only in that it never reaches the dead-letter report.

/** Thrown by the gateways for a failure that says nothing about the payload. */
export class TransientSyncError extends Error {
  readonly transient = true;
  constructor(message: string) {
    super(message);
    this.name = "TransientSyncError";
  }
}

/**
 * True for an HTTP status that means "try again later" rather than "no".
 *
 * 0 is what supabase-js (postgrest-js) reports when fetch itself threw — no
 * connection, DNS failure, or our own timeout aborting the request.
 */
export function isTransientStatus(status: number | null | undefined): boolean {
  if (status === null || status === undefined) return false;
  return status === 0 || status === 408 || status === 429 || status >= 500;
}

// The messages a failed fetch produces on React Native (iOS and Android), in
// browsers/Node (used by tests), and our own timeout wording (lib/fetchWithTimeout.ts).
const NETWORK_MESSAGE = /network request failed|failed to fetch|fetch failed|network ?error|timed out|aborted|aborterror|the internet connection appears to be offline|could not connect/i;

/** Classify anything a dispatch threw. */
export function isTransientFailure(error: unknown): boolean {
  if (error instanceof TransientSyncError) return true;
  if (error && typeof error === "object" && (error as { transient?: unknown }).transient === true) return true;
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return NETWORK_MESSAGE.test(message);
}

/**
 * Build the error a gateway throws for a failed Supabase call: transient when
 * the status says so, a plain (counted) Error otherwise.
 */
export function syncError(message: string, status?: number | null): Error {
  return isTransientStatus(status) ? new TransientSyncError(message) : new Error(message);
}
