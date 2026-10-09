// Server-side error reporting for failures that would otherwise be silent.
//
// The motivating incident: the "Polish with AI" button returned 5xx for weeks
// and nobody knew until someone happened to notice. A route that catches an
// external-integration failure and turns it into a JSON error response is
// exactly where that happens — the user sees a toast, the owner sees nothing.
//
// reportError() is a no-op when NEXT_PUBLIC_SENTRY_DSN is unset (local dev, CI,
// any deployment that has not opted in), so it is safe to call anywhere.
//
// PRIVACY: pass tags that name the AREA (route, integration, operation) — never
// a request body, note text, transcript, customer detail or dollar amount. Tags
// are the only context this accepts, on purpose; there is no `extra` channel.
import * as Sentry from "@sentry/nextjs";
import { sentryDsn } from "./options";

export type ReportContext = {
  /** The API route or job that failed, e.g. "api/ai/polish-note". */
  route: string;
} & Record<string, string | number | boolean | undefined>;

export function isMonitoringEnabled(): boolean {
  return sentryDsn() !== undefined;
}

// Each function below wraps its body in an inline `if (process.env.NEXT_PUBLIC_
// SENTRY_DSN)` rather than returning early via isMonitoringEnabled(): with the
// variable defined as "" at build time (next.config.ts), the bundler folds that
// `if` away and drops the SDK from every server bundle when monitoring is off.
export function reportError(err: unknown, context: ReportContext): void {
  if (process.env.NEXT_PUBLIC_SENTRY_DSN) {
    try {
      const tags = toTags(context);
      Sentry.captureException(toError(err, context, tags), { tags });
    } catch {
      // Monitoring must never turn a handled failure into an unhandled one.
    }
  }
}

/**
 * For a failure that is not an exception — e.g. an upstream API answered 5xx,
 * or a required key is missing in this deployment. The message must be a
 * fixed string: do NOT interpolate the upstream response body into it.
 */
export function reportFailure(message: string, context: ReportContext): void {
  if (process.env.NEXT_PUBLIC_SENTRY_DSN) {
    try {
      Sentry.captureMessage(message, { level: "error", tags: toTags(context) });
    } catch {
      // see reportError
    }
  }
}

function toTags(context: ReportContext): Record<string, string> {
  const tags: Record<string, string> = {};
  for (const [key, value] of Object.entries(context)) {
    if (value !== undefined) tags[key] = String(value);
  }
  return tags;
}

// Supabase/PostgREST errors are plain objects, not Error instances. Keep their
// message (and code, as a tag) so the report is legible, without serialising
// the whole object — its `details` can echo row values.
function toError(err: unknown, context: ReportContext, tags: Record<string, string>): Error {
  if (err instanceof Error) return err;
  if (err && typeof err === "object" && typeof (err as { message?: unknown }).message === "string") {
    const code = (err as { code?: unknown }).code;
    if (typeof code === "string") tags.error_code = code;
    return new Error((err as { message: string }).message);
  }
  return new Error(typeof err === "string" ? err : `${context.route} failed (non-Error thrown)`);
}
