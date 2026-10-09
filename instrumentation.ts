// Server/edge error monitoring (Sentry). Entirely optional: with no
// NEXT_PUBLIC_SENTRY_DSN, register() returns without importing the SDK and
// onRequestError does nothing, so the app behaves exactly as it did before.
//
// The variable is read directly (not via sentryDsn()) so the bundler can fold
// it to "" when unset and drop the SDK import from the server and edge bundles
// altogether — see the `env` note in next.config.ts.
//
// NOT the place for assertRequiredEnv() — see next.config.ts for why.
import type { Instrumentation } from "next";
import { sentryOptions } from "@/lib/monitoring/options";

export async function register() {
  // One `if` around the import, not an early return: the bundler folds a
  // constant `if` and drops the import inside it, but it does not prune code
  // that merely follows a `return`.
  if (process.env.NEXT_PUBLIC_SENTRY_DSN) {
    if (process.env.NEXT_RUNTIME === "nodejs" || process.env.NEXT_RUNTIME === "edge") {
      const Sentry = await import("@sentry/nextjs");
      Sentry.init(sentryOptions(process.env.NEXT_PUBLIC_SENTRY_DSN));
    }
  }
}

// Errors thrown from Server Components, route handlers, server actions and
// middleware that nothing else caught. Request headers and bodies are removed
// by the shared beforeSend scrubber before anything leaves the server.
export const onRequestError: Instrumentation.onRequestError = async (...args) => {
  if (process.env.NEXT_PUBLIC_SENTRY_DSN) {
    const Sentry = await import("@sentry/nextjs");
    Sentry.captureRequestError(...args);
  }
};
