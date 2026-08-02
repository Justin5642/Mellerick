import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

// PowerSync sync rules are a SECOND authorization surface: replication reads the
// logical stream with its own credentials and bypasses Postgres RLS entirely.
// Any column named in a technician's stream lands in plaintext SQLite on that
// technician's phone, whatever RLS says.
//
// The project's rule is therefore "list columns explicitly in technician-visible
// streams". It was documented but not enforced, and two streams had drifted to
// `SELECT *` — which leaks nothing today, but would silently begin syncing any
// money column added to those tables later. That silent-expansion-on-a-future-
// schema-change shape is exactly how the earlier defects in this project
// happened, so it is worth a test rather than a comment.

const YAML_PATH = join(process.cwd(), "mobile", "powersync", "sync-streams.yaml");

interface StreamDef {
  query?: string;
  auto_subscribe?: boolean;
}

function loadStreams(): Record<string, StreamDef> {
  const doc = parse(readFileSync(YAML_PATH, "utf8")) as { streams?: Record<string, StreamDef> };
  return doc.streams ?? {};
}

// A stream is technician-visible unless it is gated on the caller's profile row
// being office/admin. The gate is a JOIN (PowerSync's dialect rejects literal IN
// lists), so its absence is what makes a stream reachable by every role.
function isTechnicianVisible(query: string): boolean {
  const gated = /join\s+profiles\s+on\s+profiles\.id\s*=\s*auth\.user_id\(\)/i.test(query) &&
    /role\s*=\s*'(office|admin)'/i.test(query);
  return !gated;
}

const MONEY_COLUMN = /\b(rate|total_amount|unit_cost|unit_sell|amount|price|cost|subtotal|admin_notes)\b/i;

describe("PowerSync sync rules — technician streams", () => {
  const streams = loadStreams();

  it("defines streams at all (guards against a parse/rename silently emptying this suite)", () => {
    expect(Object.keys(streams).length).toBeGreaterThan(10);
  });

  it("never uses SELECT * in a technician-visible stream", () => {
    const offenders = Object.entries(streams)
      .filter(([, def]) => def.query && isTechnicianVisible(def.query))
      .filter(([, def]) => /select\s+\*/i.test(def.query!))
      .map(([name]) => name);

    // A wildcard means "whatever columns this table has, now and forever". A
    // future migration adding a fee or price column to one of these tables would
    // replicate it to every technician device with no code change and no review.
    expect(offenders).toEqual([]);
  });

  it("names no money column in any technician-visible stream", () => {
    const offenders = Object.entries(streams)
      .filter(([, def]) => def.query && isTechnicianVisible(def.query))
      .filter(([, def]) => MONEY_COLUMN.test(def.query!))
      .map(([name]) => name);

    expect(offenders).toEqual([]);
  });

  it("keeps every office/admin stream gated on the caller's own profile row", () => {
    // Fail-closed: a technician, or a user with no profile row, joins to nothing.
    const officeStreams = Object.entries(streams).filter(([name]) => name.startsWith("office_"));
    expect(officeStreams.length).toBeGreaterThan(0);

    const ungated = officeStreams
      .filter(([, def]) => !def.query || isTechnicianVisible(def.query))
      .map(([name]) => name);

    expect(ungated).toEqual([]);
  });
});
