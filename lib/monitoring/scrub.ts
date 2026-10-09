// Privacy scrubbing for every event and breadcrumb the web app sends to Sentry.
//
// WHY THIS IS STRICT. Two rules govern what may leave this app:
//   1. Technicians must never see a dollar figure (HANDOVER §2) — so amounts,
//      rates and invoice bodies must not end up anywhere a broader audience can
//      read them, an error tracker included.
//   2. The business holds customer names, addresses, phone numbers and job
//      notes, and voice-note transcripts.
//
// Sentry is told `sendDefaultPii: false`, but that alone still lets request
// bodies, headers and query strings through in some integrations. So this runs
// as beforeSend / beforeSendTransaction / beforeBreadcrumb and removes them
// unconditionally: an error report says WHAT broke and WHERE, never with what
// data. If you need more context in a report, add a tag naming the area (a
// route, a table, an operation) — never the payload, note text, transcript or
// an amount.
//
// No runtime import from @sentry/* here, so this is unit-testable on its own and
// adds nothing to a bundle when monitoring is off.
import type { Breadcrumb, Event } from "@sentry/nextjs";

// The only request headers worth keeping: enough to tell a browser from the
// mobile app, nothing that authenticates or identifies a person.
const SAFE_HEADERS = new Set(["user-agent", "content-type", "accept"]);

/** Drops the query string and fragment from a URL, which can carry ids, tokens (OAuth `code=`), or search text. */
export function stripQuery(url: string): string {
  const cut = url.search(/[?#]/);
  return cut === -1 ? url : url.slice(0, cut);
}

export function scrubEvent<T extends Event>(event: T): T {
  if (event.request) {
    const req = event.request;
    delete req.data;
    delete req.cookies;
    delete req.query_string;
    delete req.env;
    if (typeof req.url === "string") req.url = stripQuery(req.url);
    if (req.headers) {
      const kept: Record<string, string> = {};
      for (const [name, value] of Object.entries(req.headers)) {
        if (SAFE_HEADERS.has(name.toLowerCase()) && typeof value === "string") kept[name] = value;
      }
      req.headers = kept;
    }
  }

  // Never IP, email or username — only an opaque id, if anything set one.
  if (event.user) {
    event.user = event.user.id !== undefined ? { id: event.user.id } : {};
  }

  // `extra` is where SDK integrations and well-meaning callers park arbitrary
  // objects. Nothing in this app is allowed to rely on it, so it is dropped.
  delete event.extra;

  if (Array.isArray(event.breadcrumbs)) {
    event.breadcrumbs = event.breadcrumbs
      .map((crumb: Breadcrumb) => scrubBreadcrumb(crumb))
      .filter((crumb): crumb is Breadcrumb => crumb !== null);
  }

  return event;
}

export function scrubBreadcrumb(crumb: Breadcrumb): Breadcrumb | null {
  // console.* arguments are free-form and routinely include response bodies
  // (e.g. a failed OpenAI call logs its error text). Not worth the risk.
  if (crumb.category === "console") return null;

  const out: Breadcrumb = { ...crumb };
  if (out.data) {
    const data: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(out.data)) {
      // Keep the shape of an HTTP call (method, status, url) but never bodies.
      if (key === "url" || key === "from" || key === "to") {
        if (typeof value === "string") data[key] = stripQuery(value);
      } else if (key === "method" || key === "status_code" || key === "reason") {
        data[key] = value;
      }
    }
    out.data = data;
  }
  if (typeof out.message === "string" && /^https?:\/\//.test(out.message)) {
    out.message = stripQuery(out.message);
  }
  return out;
}
