// `fetch` with a deadline.
//
// WHY. `fetch` has NO default timeout. On a flaky mobile connection — a van
// moving between cells, a basement with one bar — a request can stay open
// indefinitely, and the outbox processor drains strictly one operation at a
// time. A single stalled Supabase write therefore froze the ENTIRE queue behind
// it: every later clock-out, photo and note waited on a promise that never
// settled, with the badge showing a pending count that never moved and no error
// anywhere. callSideEffect already had its own 30s abort for exactly this; the
// Supabase client — which carries every row write — had none.
//
// lib/supabase.ts passes this as the client's `global.fetch`, so every
// PostgREST, Auth and Storage call is bounded. A timeout surfaces through
// supabase-js as an error with status 0, which the outbox treats as transient
// (outbox/errors.ts): backed off and retried, never counted toward dead-letter.

/** Ordinary API calls: well past a healthy round trip on a poor connection. */
export const DEFAULT_TIMEOUT_MS = 30_000;
/**
 * Storage traffic (uploads, signed URLs, removes). A 1600px photo or a voice
 * recording on one bar of 3G can legitimately take more than 30 seconds, and
 * aborting a slow-but-progressing upload would only restart it from zero.
 */
export const STORAGE_TIMEOUT_MS = 120_000;

/** The deadline for a request, chosen by its URL path. */
export function timeoutFor(url: string): number {
  return /\/storage\/v1\//.test(url) ? STORAGE_TIMEOUT_MS : DEFAULT_TIMEOUT_MS;
}

/** What a request that hit its deadline rejects with. */
export class RequestTimeoutError extends Error {
  /** Read by outbox/errors.ts isTransientFailure. */
  readonly transient = true;
  constructor(readonly timeoutMs: number) {
    super(`Request timed out after ${Math.round(timeoutMs / 1000)}s`);
    this.name = "TimeoutError";
  }
}

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return (input as Request).url ?? "";
}

/**
 * Drop-in `fetch` that aborts after `timeoutMs` (default: by URL, see
 * timeoutFor). A caller's own AbortSignal is still honoured — supabase-js
 * passes one for `.abortSignal()` — and an abort the CALLER asked for is
 * rethrown untouched, so only our deadline is reported as a timeout.
 */
export async function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit = {},
  timeoutMs?: number
): Promise<Response> {
  const ms = timeoutMs ?? timeoutFor(urlOf(input));
  const controller = new AbortController();
  const outer = init.signal;
  const forwardAbort = () => controller.abort();
  if (outer) {
    if (outer.aborted) controller.abort();
    else outer.addEventListener("abort", forwardAbort);
  }
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, ms);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } catch (e) {
    if (timedOut) throw new RequestTimeoutError(ms);
    throw e;
  } finally {
    // Always cleared, including on success — an uncleared timer would fire
    // abort() on a request that has already completed.
    clearTimeout(timer);
    outer?.removeEventListener("abort", forwardAbort);
  }
}
