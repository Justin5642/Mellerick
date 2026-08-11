import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
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

// SUBSTRING, NOT WORD-BOUNDARY. This was `/\b(rate|...|price|cost|...)\b/i`,
// and `_` is a word character — so `\brate\b` did NOT match `rate_override`,
// `\bprice\b` did not match `unit_price`, `\bcost\b` did not match `total_cost`,
// and nothing matched `hourly_rate`, `charge_out_rate`, `sell_price`,
// `call_out_fee` or `margin_pct`.
//
// The consequence was not theoretical: adding `rate_override` to
// `tech_time_entries` — precisely the column migration 0045 exists to hide from
// technicians — would have passed this test green. The guard protecting the
// contractual money boundary could not see the one column the boundary had just
// been breached on.
//
// supabase/tests/money_boundary_sweep.sql uses an unanchored `~*` and does catch
// these. That file is run by hand; THIS one runs in CI, so this is the copy that
// has to be right.
const MONEY_TERMS = [
  "rate",
  "amount",
  "price",
  "cost",
  "subtotal",
  "total",
  "fee",
  "margin",
  "markup",
  "charge",
  "invoice_value",
  "admin_notes",
];

// IDENTIFIERS AND COUNTS ARE NOT MONEY. `cost_center_id` is a foreign key to a
// job stage; `total_hours` is a duration; `invoice_number` is a reference. A
// substring match alone flags all three, and a guard that cries wolf gets its
// terms deleted one by one until it catches nothing.
//
// These exclusions are lifted from supabase/tests/money_boundary_sweep.sql:85,
// which solved the same problem against the real schema:
//     and c.column_name !~* '(_id$|^id$|cost_center_id|rate_config_id|_number$)'
const NOT_MONEY = /(^id$|_id$|_number$|_hours$|^hours$|_count$|_at$|_by$)/i;

/**
 * Classify ONE column name. Deliberately per-column rather than a regex over the
 * whole query string: the previous version tested the entire SELECT, so a single
 * innocuous `cost_center_id` was indistinguishable from a real leak, and the
 * word-boundary anchors added to compensate then missed every snake_case money
 * column including `rate_override` — the exact column migration 0045 exists to
 * hide.
 */
export function isMoneyColumn(column: string): boolean {
  const name = column.trim().toLowerCase();
  if (!name) return false;
  if (NOT_MONEY.test(name)) return false;
  return MONEY_TERMS.some((term) => name.includes(term));
}

/** The column list of a `SELECT a, b, c FROM ...` stream query. */
function selectedColumns(query: string): string[] {
  const match = query.match(/select\s+([\s\S]*?)\s+from\s/i);
  if (!match) return [];
  return match[1]
    .split(",")
    // Stripping the table qualifier also normalises `time_entries.*` to `*`,
    // which is what lets usesWildcard below recognise a qualified star.
    .map((c) => c.trim().replace(/^\w+\./, ""))
    .filter(Boolean);
}

// Does this query select whole rows rather than a named list?
//
// Asked of the PARSED column list, not of the raw query, so this and the money
// check can never disagree about what a stream selects. The regex this replaced
// matched a literal `select` followed by a bare star, which saw only a star in
// first position: it did not match `SELECT time_entries.*` — the form every
// office stream uses, and therefore the form a copy-pasted technician stream
// arrives in — nor a star later in the list.
function usesWildcard(query: string): boolean {
  return selectedColumns(query).includes("*");
}

/** Technician-visible streams that select whole rows. */
function wildcardOffenders(streams: Record<string, StreamDef>): string[] {
  return Object.entries(streams)
    .filter(([, def]) => def.query && isTechnicianVisible(def.query))
    .filter(([, def]) => usesWildcard(def.query!))
    .map(([name]) => name);
}

/** `stream.column` for every money column a technician-visible stream names. */
function moneyOffenders(streams: Record<string, StreamDef>): string[] {
  return Object.entries(streams)
    .filter(([, def]) => def.query && isTechnicianVisible(def.query))
    .flatMap(([name, def]) =>
      selectedColumns(def.query!)
        .filter(isMoneyColumn)
        .map((column) => `${name}.${column}`)
    );
}

// There must be exactly ONE deployable sync config. A second, superseded YAML
// sitting beside the live one is a standing hazard: both are security-critical,
// they are written in different PowerSync dialects, and nothing in the filenames
// says which is authoritative. Deploying the wrong one is a single mistake away.
describe("PowerSync config — exactly one deployable artifact", () => {
  it("has no sync YAML beside sync-streams.yaml", () => {
    const dir = join(process.cwd(), "mobile", "powersync");
    const yamls = readdirSync(dir).filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"));
    expect(yamls).toEqual(["sync-streams.yaml"]);
  });
});

// THE CLASSIFIER NEEDS ITS OWN TEST.
//
// Every assertion below depends on MONEY_COLUMN actually classifying. A regex
// that silently matches nothing makes the whole suite pass while the boundary is
// wide open — which is exactly what the previous word-boundary version did for
// every snake_case money column. Testing the streams without testing the
// detector is testing nothing.
describe("MONEY_COLUMN detector", () => {
  const mustMatch = [
    "rate_override", // the column 0045 exists to hide — missed by the old regex
    "unit_price",
    "total_cost",
    "hourly_rate",
    "charge_out_rate",
    "sell_price",
    "call_out_fee",
    "margin_pct",
    "total_amount",
    "subtotal",
    "admin_notes",
    "invoice_value",
  ];
  for (const column of mustMatch) {
    it(`flags ${column}`, () => {
      expect(isMoneyColumn(column)).toBe(true);
    });
  }

  const mustNotMatch = [
    "id",
    "job_id",
    "clock_in",
    "clock_out",
    "status",
    "serial_number",
    "make",
    "model",
    // The false positives a naive substring match produces, each a real column
    // in a technician-visible stream today.
    "cost_center_id", // a job stage FK, not a cost
    "total_hours", // a duration, not a total
    "invoice_number", // a reference, not a value
    "created_at",
    "logged_by",
  ];
  for (const column of mustNotMatch) {
    it(`does not flag ${column}`, () => {
      expect(isMoneyColumn(column)).toBe(false);
    });
  }
});

// THE GUARD HAS TO CATCH THE EDIT THAT HAS NOT HAPPENED YET.
//
// Every stream in the YAML is correctly gated today, so asserting over the YAML
// alone proves only that nobody has made the mistake — not that this file would
// notice if they did. The realistic mistake has a known shape: every office
// stream is written `SELECT <table>.*`, so a technician stream arrives by
// copying one and dropping the `JOIN profiles` gate. A qualified star is not the
// bare `SELECT *` an unqualified regex looks for, and stripping the qualifier
// leaves `*`, which is not a money column name — so all four assertions above
// stayed green while whole rows of time_entries reached the device.
describe("the guard catches a qualified wildcard", () => {
  // office_time_entries (sync-streams.yaml:219) with its role gate replaced by
  // the technician job scope. time_entries carries rate_override, the column
  // migration 0045 exists to keep off technician devices.
  const leakedQuery =
    "SELECT time_entries.* FROM time_entries WHERE job_id IN (SELECT id FROM jobs WHERE assigned_to = auth.user_id())";
  const leaked = { tech_time_entries: { auto_subscribe: true, query: leakedQuery } };

  it("sees the stream as technician-visible", () => {
    expect(isTechnicianVisible(leakedQuery)).toBe(true);
  });

  it("rejects `SELECT time_entries.*` as a wildcard", () => {
    expect(wildcardOffenders(leaked)).toEqual(["tech_time_entries"]);
  });

  it("rejects a qualified star anywhere in the column list", () => {
    // `SELECT id, time_entries.* FROM …` is the same leak with a decoy column in
    // front of it, and it satisfies the anti-vacuity check honestly.
    const mixed = {
      tech_time_entries: {
        auto_subscribe: true,
        query: "SELECT id, time_entries.* FROM time_entries WHERE job_id = auth.user_id()",
      },
    };
    expect(wildcardOffenders(mixed)).toEqual(["tech_time_entries"]);
  });

  it("still rejects a bare `SELECT *`", () => {
    const bare = {
      tech_time_entries: {
        auto_subscribe: true,
        query: "SELECT * FROM time_entries WHERE job_id = auth.user_id()",
      },
    };
    expect(wildcardOffenders(bare)).toEqual(["tech_time_entries"]);
  });

  it("does not mistake `time_entries.*` for a column list the money check can read", () => {
    // Naming what the money assertion actually receives: one entry, `*`, which
    // no money term matches. That is why the wildcard rule — not the money rule
    // — has to be the one that rejects this stream.
    expect(selectedColumns(leakedQuery)).toEqual(["*"]);
    expect(moneyOffenders(leaked)).toEqual([]);
  });

  it("does not count a wildcard stream as one whose columns it can see", () => {
    // The anti-vacuity check excludes wildcard streams by design. If the
    // wildcard test cannot see a qualified star, this exclusion stops applying
    // and `["*"]` is accepted as a genuine, non-empty column list.
    expect(usesWildcard(leakedQuery)).toBe(true);
  });
});

describe("PowerSync sync rules — technician streams", () => {
  const streams = loadStreams();

  it("defines streams at all (guards against a parse/rename silently emptying this suite)", () => {
    expect(Object.keys(streams).length).toBeGreaterThan(10);
  });

  it("never uses SELECT * in a technician-visible stream", () => {
    // A wildcard means "whatever columns this table has, now and forever". A
    // future migration adding a fee or price column to one of these tables would
    // replicate it to every technician device with no code change and no review.
    expect(wildcardOffenders(streams)).toEqual([]);
  });

  it("names no money column in any technician-visible stream", () => {
    // Per COLUMN, not per query string. PowerSync replicates with its own
    // credentials and bypasses Postgres RLS entirely, so any column listed here
    // lands in plaintext SQLite on that technician's phone whatever the policies
    // say. This list is the only thing standing between a money column and the
    // device.
    expect(moneyOffenders(streams)).toEqual([]);
  });

  it("can actually see the columns it is checking (guards against a parse returning nothing)", () => {
    // If selectedColumns ever fails to parse the dialect, the assertion above
    // silently checks an empty list and passes forever. That is the failure mode
    // this whole file exists to prevent, so it gets its own check.
    const technicianStreams = Object.entries(streams).filter(
      ([, def]) => def.query && isTechnicianVisible(def.query) && !usesWildcard(def.query)
    );
    expect(technicianStreams.length).toBeGreaterThan(5);
    for (const [name, def] of technicianStreams) {
      expect(selectedColumns(def.query!).length, `${name} parsed to zero columns`).toBeGreaterThan(0);
    }
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
