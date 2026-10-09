// Shared Sentry.init options for every web runtime (browser, Node, edge), so
// the privacy settings cannot drift between them. See scrub.ts for why.
import type { BrowserOptions, NodeOptions, EdgeOptions } from "@sentry/nextjs";
import { scrubBreadcrumb, scrubEvent } from "./scrub";

/**
 * The DSN, or undefined when monitoring is off. NEXT_PUBLIC_ so the same value
 * is inlined into the browser bundle and read by the server. With no DSN,
 * nothing calls Sentry.init and every helper here is a no-op.
 */
export function sentryDsn(): string | undefined {
  return process.env.NEXT_PUBLIC_SENTRY_DSN || undefined;
}

export function sentryOptions(dsn: string): BrowserOptions & NodeOptions & EdgeOptions {
  return {
    dsn,
    environment:
      process.env.NEXT_PUBLIC_VERCEL_ENV || process.env.VERCEL_ENV || process.env.NODE_ENV,
    // Customer data and the money rule: never let the SDK attach IPs, cookies,
    // request bodies or user details on its own (HANDOVER §2, §12).
    sendDefaultPii: false,
    // Errors are the point; a small trace sample is enough to see slow routes
    // without burning the free-tier quota.
    tracesSampleRate: 0.1,
    // No session replay — it records the screen, and the screen shows customer
    // details and, for office staff, dollar figures.
    replaysSessionSampleRate: 0,
    replaysOnErrorSampleRate: 0,
    beforeSend: (event) => scrubEvent(event),
    beforeSendTransaction: (event) => scrubEvent(event),
    beforeBreadcrumb: (crumb) => scrubBreadcrumb(crumb),
  };
}
