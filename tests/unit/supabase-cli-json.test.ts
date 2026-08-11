import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseCliRows } from "../../scripts/supabase-cli-json.mjs";

// ============================================================================
// The Supabase CLI emits THREE different shapes for the same query, and which
// one you get depends on how the process is attached.
//
// Measured against the live linked project on 2026-08-12, CLI 2.113.0. The
// fixtures beside this file are the VERBATIM captured bytes of each:
//
//   flags                  piped / --agent yes      real terminal / --agent no
//   (none)                 {boundary, rows:[...]}   box-drawing TABLE
//   --output-format json   {boundary, rows:[...]}   bare array [{...}]
//
// There is NO flag combination that yields one shape in both modes. Agent
// detection wins, and it is decided by process attachment.
//
// WHY THIS FILE EXISTS
// Both check-sync-health.mjs and check-migrations.mjs were written against the
// piped envelope alone, because they were only ever developed by piping their
// output. The first person to run them in PowerShell got a different shape and
// `npm run check:sync` died on "Unexpected non-whitespace character after JSON
// at position 116" — the parser had sliced from the first `{`, which inside a
// bare array is the first ROW, and then hit the array's closing `]`.
//
// That is the defect class this file guards: CODE THAT BEHAVES DIFFERENTLY FOR
// A HUMAN THAN FOR THE PROCESS THAT DEVELOPED IT. Piping it to check it is the
// one thing that cannot detect it.
//
// The fix is NOT "force the format" — that was tried and shipped, and it is
// what broke the human's terminal, because forcing the format changes the
// interactive shape from table to array without making the two modes agree.
// The fix is a parser that accepts BOTH JSON shapes and REFUSES the table.
// ============================================================================

const FIXTURES = join(__dirname, "..", "fixtures", "supabase-cli");
const fixture = (name: string) => readFileSync(join(FIXTURES, `${name}.txt`), "utf8");

const AGENT_ENVELOPE = fixture("db-query-agent-yes");
const BARE_ARRAY = fixture("db-query-agent-no-json");
const HUMAN_TABLE = fixture("db-query-agent-no-text");

describe("the fixtures are real and distinct", () => {
  it("captured three genuinely different shapes", () => {
    // Vacuity guard. If a future CLI made these identical, every test below
    // would still pass while testing one shape three times — which is exactly
    // how the original bug survived: one shape, exercised repeatedly.
    expect(new Set([AGENT_ENVELOPE, BARE_ARRAY, HUMAN_TABLE]).size).toBe(3);
    expect(AGENT_ENVELOPE).toContain('"boundary"');
    expect(BARE_ARRAY.trimStart().split("\n")[1]).toBe("[");
    expect(HUMAN_TABLE).toContain("┌");
  });
});

describe("parseCliRows", () => {
  it("reads rows from the agent envelope — the shape a pipe gets", () => {
    const rows = parseCliRows(AGENT_ENVELOPE);
    expect(rows).toHaveLength(1);
    expect(Object.values(rows[0])[0]).toContain("powersync");
  });

  it("reads rows from the bare array — the shape a REAL TERMINAL gets", () => {
    // The regression. Before the fix this threw
    // "Unexpected non-whitespace character after JSON at position 132",
    // which is the same defect the user hit at position 116 on the live query.
    const rows = parseCliRows(BARE_ARRAY);
    expect(rows).toHaveLength(1);
    expect(Object.values(rows[0])[0]).toContain("powersync");
  });

  it("returns the SAME rows from both JSON shapes", () => {
    // The two modes describe one database. If the parser ever read them
    // differently, a health check would give a human and a cron different
    // answers about the same slot — worse than failing, because both look
    // authoritative.
    expect(parseCliRows(BARE_ARRAY)).toEqual(parseCliRows(AGENT_ENVELOPE));
  });

  it("REFUSES the human table rather than mis-reading it", () => {
    // It must throw, not return []. Returning [] from check-sync-health means
    // "no replication slot exists" — a false UNHEALTHY alarm. Returning [] from
    // check-migrations means "production has applied nothing", against which no
    // draft header can be caught lying and every one of them looks honest.
    // A confident wrong answer is worse than the crash it replaces.
    expect(() => parseCliRows(HUMAN_TABLE)).toThrow();
  });

  it("names the table shape in the refusal, and says how to fix it", () => {
    // The original failure cost several round-trips because the message was
    // only the JSON.parse exception — it never said what had arrived instead.
    let message = "";
    try {
      parseCliRows(HUMAN_TABLE);
    } catch (e) {
      message = String((e as Error).message);
    }
    expect(message).toMatch(/table/i);
    expect(message).toMatch(/--output-format json/);
  });

  it("puts the raw output in the error so the next failure is diagnosable", () => {
    let message = "";
    try {
      parseCliRows("supabase: command not found");
    } catch (e) {
      message = String((e as Error).message);
    }
    expect(message).toContain("supabase: command not found");
  });

  it("throws on output with no JSON at all", () => {
    expect(() => parseCliRows("")).toThrow();
    expect(() => parseCliRows("Initialising login role...")).toThrow();
  });

  it("throws rather than returning a non-array from a JSON scalar", () => {
    // `JSON.parse("123")` succeeds. A parser that trusted it would hand back a
    // number where rows were expected and fail somewhere further away.
    expect(() => parseCliRows("123")).toThrow();
    expect(() => parseCliRows('{"boundary":"x","warning":""}')).toThrow();
  });

  it("does not silently accept an envelope whose rows are not an array", () => {
    expect(() => parseCliRows('{"boundary":"x","rows":"nope"}')).toThrow();
  });

  it("allows an empty result set through — emptiness is the CALLER's policy", () => {
    // check-migrations must refuse an empty ledger; check-sync-health must
    // report an empty slot list as UNHEALTHY. Those are different rules about
    // the same shape, so this layer must not decide for either of them.
    expect(parseCliRows('{"boundary":"x","rows":[],"warning":""}')).toEqual([]);
    expect(parseCliRows("Initialising login role...\n[]")).toEqual([]);
  });
});
