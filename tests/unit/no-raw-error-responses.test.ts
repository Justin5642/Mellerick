import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

// API routes returned raw database / auth / SDK error text to the client —
// `{ error: error.message }`. Postgres messages name constraints, columns and
// functions; GoTrue's say whether an account exists; SDK errors can carry
// hostnames. The detail belongs in the server log (console.error, and
// reportError for Sentry); the client gets a fixed sentence.
//
// Scanned, not listed, so a new route cannot quietly reintroduce it.

const API = join(process.cwd(), "app", "api");

// Exceptions, each with its reason. Keep this short.
const ALLOWED = new Set([
  // Office/admin-only, and the thrown text IS the diagnosis the person
  // pressing the button needs ("Xero not connected", "RESEND_API_KEY is
  // missing", "reconnect Xero"). Generic text would leave them stuck.
  "app/api/xero/sync-now/route.ts",
  "app/api/google/sync-now/route.ts",
  "app/api/invoices/[id]/send/route.ts",
  "app/api/quotes/[id]/send/route.ts",
]);
// Another open PR rewrites the staff routes; they are left to it.
const SKIP_PREFIX = "app/api/staff/";

function routes(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) routes(p, out);
    else if (e === "route.ts") out.push(relative(process.cwd(), p).replace(/\\/g, "/"));
  }
  return out;
}

describe("API routes do not return raw error messages", () => {
  const files = routes(API);

  it("found the routes", () => {
    expect(files.length).toBeGreaterThan(30);
  });

  it("no NextResponse.json body carries an error's .message", () => {
    const offenders: string[] = [];
    for (const f of files) {
      if (f.startsWith(SKIP_PREFIX) || ALLOWED.has(f)) continue;
      readFileSync(f, "utf8")
        .split("\n")
        .forEach((line, i) => {
          if (/NextResponse\.json\(/.test(line) && /\b\w*(err|error|Error|Err)\??\.message\b/.test(line)) {
            offenders.push(`${f}:${i + 1}`);
          }
        });
    }
    expect(offenders).toEqual([]);
  });
});
