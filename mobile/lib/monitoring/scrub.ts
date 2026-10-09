// Privacy scrubbing for every event and breadcrumb the mobile app sends to
// Sentry. Mirrors lib/monitoring/scrub.ts in the web app (two npm projects, no
// shared package, so the rules are duplicated deliberately — keep them in step).
//
// WHY THIS IS STRICT:
//   1. Technicians must never see a dollar figure (HANDOVER §2). An error
//      tracker is a wider audience than the app, so amounts, rates and payloads
//      must never reach it.
//   2. The app carries customer names, addresses, job notes, voice-note
//      transcripts and signatures.
//
// So a report says WHAT failed and WHERE (tags: table, op, aggregate, source),
// never with what data. Request bodies, cookies, headers, query strings,
// `extra`, console breadcrumbs and touch breadcrumbs (which carry on-screen
// labels) are all removed here, unconditionally.
//
// No runtime import from @sentry/* so this is unit-testable on its own.
import type { Breadcrumb, Event } from "@sentry/react-native";

const SAFE_HEADERS = new Set(["user-agent", "content-type", "accept"]);

// Breadcrumb categories whose message/data can contain on-screen text or
// free-form log arguments (which here include response bodies).
const DROPPED_CATEGORIES = new Set(["console", "touch", "ui.click", "ui.input"]);

/** Drops the query string and fragment — PostgREST URLs carry row filters there. */
export function stripQuery(url: string): string {
  const cut = url.search(/[?#]/);
  return cut === -1 ? url : url.slice(0, cut);
}

/**
 * Makes a server error message safe to attach: numbers become "#" (an amount
 * is a number) and quoted values after a colon — Postgres's way of echoing the
 * offending input, e.g. `invalid input syntax for type numeric: "12.50"` — are
 * replaced. Table and constraint names, which are what make the message useful,
 * survive. Truncated so nothing long rides along.
 */
export function redactMessage(message: string, max = 200): string {
  return message
    .replace(/:\s*"[^"]*"/g, ': "…"')
    .replace(/\d[\d.,]*/g, "#")
    .slice(0, max);
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
  if (event.user) {
    event.user = event.user.id !== undefined ? { id: event.user.id } : {};
  }
  delete event.extra;
  if (Array.isArray(event.breadcrumbs)) {
    event.breadcrumbs = event.breadcrumbs
      .map((crumb: Breadcrumb) => scrubBreadcrumb(crumb))
      .filter((crumb): crumb is Breadcrumb => crumb !== null);
  }
  return event;
}

export function scrubBreadcrumb(crumb: Breadcrumb): Breadcrumb | null {
  if (crumb.category && DROPPED_CATEGORIES.has(crumb.category)) return null;
  const out: Breadcrumb = { ...crumb };
  if (out.data) {
    const data: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(out.data)) {
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
