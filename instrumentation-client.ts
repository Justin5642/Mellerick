// Browser error monitoring (Sentry). Runs before the app hydrates. A no-op —
// the SDK is never initialised, and is dropped from the bundle — unless
// NEXT_PUBLIC_SENTRY_DSN was set at build time (NEXT_PUBLIC_* values are
// inlined into the bundle).
//
// Every guard reads `process.env.NEXT_PUBLIC_SENTRY_DSN` inline rather than via
// a variable or sentryDsn(): the bundler can only fold the literal expression
// (defined as "" when unset, see next.config.ts), and only a folded guard lets
// it remove the SDK import.
//
// No session replay: the screen shows customer details and, for office staff,
// dollar figures. See lib/monitoring/scrub.ts.
import * as Sentry from "@sentry/nextjs";
import { sentryOptions } from "@/lib/monitoring/options";

if (process.env.NEXT_PUBLIC_SENTRY_DSN) {
  Sentry.init(sentryOptions(process.env.NEXT_PUBLIC_SENTRY_DSN));
}

// Lets Sentry attribute client-side navigations to a route.
export const onRouterTransitionStart = process.env.NEXT_PUBLIC_SENTRY_DSN
  ? Sentry.captureRouterTransitionStart
  : undefined;
