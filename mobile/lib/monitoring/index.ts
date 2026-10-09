// Crash and failure reporting for the mobile app (Sentry). Entirely optional:
// with no EXPO_PUBLIC_SENTRY_DSN the SDK is never initialised and every
// function here returns without doing anything, so the app behaves exactly as
// it did before. The native module still needs a new dev-client / EAS build to
// be present at all — see HANDOVER §12.
//
// What it exists to surface — failures that are otherwise SILENT on a phone in
// a technician's pocket:
//   - an outbox write that exhausts its retries and dead-letters (the badge says
//     "not synced", but nobody in the office knows);
//   - a background drain failing in the sync engine;
//   - the sync-status poll failing for a reason other than the expected dev
//     teardown noise (HANDOVER §10 trap 7).
//
// PRIVACY: tags only — table, op, aggregate, source. Never a payload, note
// text, transcript, customer detail or amount. See scrub.ts.
import * as Sentry from "@sentry/react-native";
import type { ComponentType } from "react";
import type { Operation } from "../data/outbox/types";
import { redactMessage, scrubBreadcrumb, scrubEvent } from "./scrub";

type Env = Record<string, string | undefined>;

function isUnset(value: string | undefined): boolean {
  if (value === undefined || value === null) return true;
  const t = String(value).trim();
  return t === "" || t === "undefined" || t === "null";
}

/**
 * The DSN, or undefined when monitoring is off. Expo inlines EXPO_PUBLIC_* at
 * build time only when written out literally as `process.env.EXPO_PUBLIC_…`,
 * so the default argument must stay in exactly that form.
 */
export function monitoringDsn(
  env: Env = { EXPO_PUBLIC_SENTRY_DSN: process.env.EXPO_PUBLIC_SENTRY_DSN }
): string | undefined {
  const dsn = env.EXPO_PUBLIC_SENTRY_DSN;
  return isUnset(dsn) ? undefined : String(dsn).trim();
}

let enabled = false;

export function isMonitoringEnabled(): boolean {
  return enabled;
}

/** Call once, at module scope in the root layout. Returns whether it started. */
export function initMonitoring(env?: Env): boolean {
  const dsn = monitoringDsn(env);
  if (!dsn) return false;
  if (enabled) return true;
  try {
    Sentry.init({
      dsn,
      environment: __DEV__ ? "development" : "production",
      sendDefaultPii: false,
      // Errors only. Performance spans would carry PostgREST URLs (row filters)
      // and are not what this is for.
      tracesSampleRate: 0,
      // A screenshot or view hierarchy is the screen itself — customer details,
      // and for office users, dollar figures. Never.
      attachScreenshot: false,
      attachViewHierarchy: false,
      enableUserInteractionTracing: false,
      beforeSend: (event) => scrubEvent(event),
      beforeSendTransaction: (event) => scrubEvent(event),
      beforeBreadcrumb: (crumb) => scrubBreadcrumb(crumb),
    });
    enabled = true;
  } catch (e) {
    if (__DEV__) console.warn("[monitoring] Sentry.init failed; continuing without it:", e);
  }
  return enabled;
}

/** Sentry.wrap when monitoring started (catches render crashes), else the component unchanged. */
export function wrapRoot<P extends object>(component: ComponentType<P>): ComponentType<P> {
  return enabled ? (Sentry.wrap(component as ComponentType<Record<string, unknown>>) as unknown as ComponentType<P>) : component;
}

/**
 * The expected dev-time teardown error (HANDOVER §10 trap 7): a SQLite call
 * in flight when Fast Refresh / sign-out released the native handle. Caught
 * and recovered on the next tick — reporting it would be pure noise.
 */
export function isReleasedSharedObjectError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  const code = err && typeof err === "object" ? (err as { code?: unknown }).code : undefined;
  return (
    code === "ERR_USING_RELEASED_SHARED_OBJECT" ||
    message.includes("ERR_USING_RELEASED_SHARED_OBJECT") ||
    message.includes("already released")
  );
}

// A failing poll would otherwise report every 3 seconds. One report per
// distinct (source, message) per app session is enough to know it happens.
const reportedOnce = new Set<string>();
const MAX_DEDUPE_KEYS = 100;

function toError(err: unknown, fallback: string): Error {
  if (err instanceof Error) return err;
  if (err && typeof err === "object" && typeof (err as { message?: unknown }).message === "string") {
    return new Error((err as { message: string }).message);
  }
  return new Error(typeof err === "string" ? err : fallback);
}

/**
 * A caught, background failure: a sync drain, the status poll, a retry.
 * Skips the expected released-object teardown error, and reports each distinct
 * failure once per session.
 */
export function reportSyncError(err: unknown, source: "sync-engine" | "sync-status" | "sync-retry" | "background-sync"): void {
  if (!enabled || isReleasedSharedObjectError(err)) return;
  try {
    const error = toError(err, `${source} failed`);
    const key = `${source}:${error.message}`;
    if (reportedOnce.has(key)) return;
    if (reportedOnce.size < MAX_DEDUPE_KEYS) reportedOnce.add(key);
    Sentry.captureException(error, { tags: { source } });
  } catch {
    // Monitoring must never turn a handled failure into an unhandled one.
  }
}

/**
 * An outbox operation reached the terminal "dead" state: the work the
 * technician did will not reach the server without someone pressing Retry.
 * Tags identify the operation; the payload is NEVER attached, and the server's
 * error message is redacted (numbers and echoed values removed).
 */
export function reportDeadLetter(op: Operation, reason: string): void {
  if (!enabled) return;
  try {
    const tags: Record<string, string> =
      op.kind === "write"
        ? { source: "outbox", kind: "write", table: op.table, op: op.op, aggregate: op.aggregate }
        : { source: "outbox", kind: "side_effect", effect: op.effect };
    tags.attempts = String(op.attempts);
    Sentry.captureException(new Error(`Outbox operation dead-lettered: ${redactMessage(reason)}`), { tags });
  } catch {
    // see reportSyncError
  }
}

/** Test-only: reset module state between cases. */
export function __resetMonitoringForTests(): void {
  enabled = false;
  reportedOnce.clear();
}
