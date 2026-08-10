import { describe, it, expect } from "vitest";
import { readdirSync, statSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

import { referencedColumns, objectLiteralBody, chainAfter } from "../helpers/column-references";

// ============================================================================
// Items N13 and N14 — the drift guard's own parser, finally under test.
//
// schema-column-contract.test.ts asserts that every column the source names
// exists in the migration history. That check is only as good as its
// extraction: a parser that quietly sees less than it claims does not fail the
// suite, it narrows the net, and the guard stays green while the drift walks
// past. This repo has been bitten by precisely that — migration 0053's `[^t]`
// regex matched the space inside the correctly-wrapped form, so it fired on
// exactly the policies that were already right.
//
// N14: the payload regex was `\{([^}]*)\}`, which stops at the FIRST `}`.
// Every key after a nested object was invisible.
//
// N13: the window comment said "~600 chars" while the code used 400. Measuring
// instead of choosing between them showed both were wrong and both too small.
// The last test here re-measures the tree, so the constant cannot drift from
// the code again — which is the actual defect N13 describes.
// ============================================================================

describe("objectLiteralBody — brace balancing (N14)", () => {
  it("returns the whole body of a literal containing a nested object", () => {
    const src = `x({ meta: { a: 1 }, ready_to_invoice: true })`;
    expect(objectLiteralBody(src, src.indexOf("{"))).toBe(` meta: { a: 1 }, ready_to_invoice: true `);
  });

  it("is not fooled by a brace inside a string", () => {
    const src = `x({ note: "}", ready_to_invoice: true })`;
    expect(objectLiteralBody(src, src.indexOf("{"))).toContain("ready_to_invoice");
  });

  it("is not fooled by a brace inside a template literal", () => {
    const src = "x({ label: `${a}}`, ready_to_invoice: true })";
    expect(objectLiteralBody(src, src.indexOf("{"))).toContain("ready_to_invoice");
  });

  it("returns null rather than guessing at an unterminated literal", () => {
    const src = `x({ a: 1`;
    expect(objectLiteralBody(src, src.indexOf("{"))).toBeNull();
  });
});

describe("referencedColumns — write payloads (N14)", () => {
  it("sees keys that follow a nested object", () => {
    // THE BUG. `[^}]*` captured ` meta: { a: 1` and stopped, so the guard
    // never saw ready_to_invoice — the exact column whose absence from the
    // schema is the production bug the contract test exists to catch.
    const src = `await supabase.from("jobs").update({ meta: { a: 1 }, ready_to_invoice: true }).eq("id", id)`;
    expect([...referencedColumns(src, "jobs")].sort()).toEqual(["id", "meta", "ready_to_invoice"]);
  });

  it("does NOT count a nested object's keys as columns of the table", () => {
    // `a` belongs to the interior of a JSON column, not to `jobs`. Counting it
    // would invent a column nobody claimed exists and fail the guard falsely.
    const src = `await supabase.from("jobs").update({ meta: { a: 1 } })`;
    expect([...referencedColumns(src, "jobs")]).toEqual(["meta"]);
  });

  it("still sees shorthand keys", () => {
    // Not hypothetical: the geofence auto-clock wrote `hours` this way and the
    // colon-only pattern walked past it for months.
    const src = `await supabase.from("time_entries").insert({ hours, entry_type: "travel" })`;
    expect([...referencedColumns(src, "time_entries")].sort()).toEqual(["entry_type", "hours"]);
  });

  it("survives an array value containing objects", () => {
    const src = `await supabase.from("invoices").insert({ lines: [{ q: 1 }, { q: 2 }], total: 5 })`;
    expect([...referencedColumns(src, "invoices")].sort()).toEqual(["lines", "total"]);
  });
});

describe("referencedColumns — chain scoping (N13)", () => {
  it("reads a column past the 400 chars the code used to stop at", () => {
    const src = `supabase.from("jobs")\n${"  // padding\n".repeat(60)}  .eq("ready_to_invoice", true)`;
    expect([...referencedColumns(src, "jobs")]).toEqual(["ready_to_invoice"]);
  });

  it("does not attribute the NEXT chain's columns to this table", () => {
    // Following `.method(` continuations blindly would swallow a second
    // `.from(` and everything after it, so the walk stops at one. Caught by
    // this test the first time it ran.
    const src = `supabase.from("jobs").select("*").from("invoices").eq("xero_invoice_id", x)`;
    expect([...referencedColumns(src, "jobs")]).toEqual([]);
  });

  it("survives an apostrophe in a comment mid-chain", () => {
    // `// the customer's name` opens a string that never closes. A scanner
    // that does not skip comments then treats every following bracket as
    // quoted and stops counting — silently. Two files in this tree do this.
    const src = [
      `supabase.from("jobs")`,
      `  // the customer's own reference, not ours`,
      `  .eq("status", s)`,
    ].join("\n");
    expect([...referencedColumns(src, "jobs")]).toEqual(["status"]);
  });

  it("stops at the end of the statement, not after N characters", () => {
    // THE REGRESSION THIS REPLACED A NUMBER WITH. Raising the window to cover
    // the longest real chain made the scan run out of this supabase statement
    // and into the GOOGLE client's `.update({ calendarId, eventId, ... })`,
    // which was then reported as three missing `jobs` columns. Verbatim shape
    // from app/api/jobs/[id]/sync-calendar/route.ts.
    const src = [
      `const { data: job } = await supabase`,
      `  .from("jobs")`,
      `  .select("*, customers(name), sites(address_line1, suburb)")`,
      `  .eq("id", id)`,
      `  .single();`,
      ``,
      `await calendar.events.update({`,
      `  calendarId: "primary",`,
      `  eventId: job.google_event_id,`,
      `  requestBody: eventBody,`,
      `});`,
    ].join("\n");

    expect([...referencedColumns(src, "jobs")]).toEqual(["id"]);
  });

  it("keeps following a chain that is annotated mid-way", () => {
    const src = [
      `supabase.from("jobs")`,
      `  // the queue reads only what it renders`,
      `  .select("id")`,
      `  .eq("ready_to_invoice", true)`,
    ].join("\n");
    expect([...referencedColumns(src, "jobs")]).toEqual(["ready_to_invoice"]);
  });

  it("is not confused by parentheses inside a select string", () => {
    const src = `supabase.from("jobs").select("*, customers(name)").eq("status", s)`;
    expect([...referencedColumns(src, "jobs")]).toEqual(["status"]);
  });
});

// ---------------------------------------------------------------------------
// The anti-rot assertion. N13 was not "a wrong number" — it was a number that
// had no way of noticing it no longer described the code beside it. Following
// the chain removes the number entirely, and this checks the walker terminates
// where the statement does across the whole real tree, rather than trusting a
// handful of hand-written cases.
// ---------------------------------------------------------------------------
describe("chainAfter stops where the statement stops, across the tree", () => {
  const REPO = join(__dirname, "..", "..");
  const ROOTS = ["app", "lib", "components", join("mobile", "lib"), join("mobile", "app"), join("mobile", "components")];

  function sourceFiles(): string[] {
    const out: string[] = [];
    const walk = (dir: string) => {
      let entries: string[];
      try {
        entries = readdirSync(dir);
      } catch {
        return;
      }
      for (const e of entries) {
        if (e === "node_modules" || e === ".next" || e.startsWith(".")) continue;
        const p = join(dir, e);
        try {
          if (statSync(p).isDirectory()) walk(p);
          else if (/\.(ts|tsx)$/.test(e) && !/\.test\.tsx?$/.test(e)) out.push(p);
        } catch {
          // Walking the live tree; a file can vanish mid-run.
        }
      }
    };
    for (const r of ROOTS) walk(join(REPO, r));
    return out;
  }

  /** Every `.from("table")` in the tree, with the chain the walker extracts. */
  function chains(): Array<{ file: string; table: string; chain: string }> {
    const out: Array<{ file: string; table: string; chain: string }> = [];
    for (const file of sourceFiles()) {
      let src: string;
      try {
        src = readFileSync(file, "utf8");
      } catch {
        continue;
      }
      for (const m of src.matchAll(/\.from\(\s*["'`](\w+)["'`]\s*\)/g)) {
        out.push({
          file: relative(REPO, file).replace(/\\/g, "/"),
          table: m[1],
          chain: chainAfter(src, m.index! + m[0].length),
        });
      }
    }
    return out;
  }

  const all = chains();

  it("found a meaningful number of chains to walk", () => {
    // Without this the assertions below are trivially true if the walker or the
    // file scan ever stops matching — the same vacuity N14 produced.
    expect(all.length).toBeGreaterThan(300);
  });

  it("never walks past the end of a statement into the next one", () => {
    // A chain is one expression, so a `;` OUTSIDE every bracket can only mean
    // the walker overran — which is exactly what a character window did.
    //
    // "outside every bracket" is the whole assertion. A plain `includes(";")`
    // reported four false positives on the first run: `.then(({ data }) => {
    // …; … })` carries semicolons inside its callback, and a chain annotated
    // with commented-out code (lib/approval-invoice-guard.ts) carries them
    // inside the comment. Neither is an overrun.
    const overran = all
      .filter((c) => hasTopLevelSemicolon(c.chain))
      .map((c) => `${c.file} (.from("${c.table}")) ran into: ${c.chain.slice(0, 140).replace(/\s+/g, " ")}`);

    expect(overran).toEqual([]);
  });

  it("does not stop mid-expression, leaving a payload half-read", () => {
    // The opposite failure, and the one N14 actually produced: ending early
    // loses columns SILENTLY. A chain that stopped inside a call or an object
    // literal has unbalanced brackets, which is checkable without knowing where
    // it should have ended.
    const unbalanced = all
      .filter((c) => !bracketsBalanced(c.chain))
      .map((c) => `${c.file} (.from("${c.table}")) ends mid-expression: …${c.chain.slice(-100).replace(/\s+/g, " ")}`);

    expect(unbalanced).toEqual([]);
  });

  it("reaches a terminating call on chains that have one", () => {
    // A supabase chain that names a table and then does nothing is either dead
    // code or a walker that gave up immediately. Neither should be common, and
    // a sudden rise in them means the walker stopped matching.
    const empty = all.filter((c) => c.chain.trim() === "").length;
    expect(empty / all.length).toBeLessThan(0.05);
  });
});

/**
 * True when every (, [ and { in `src` is closed, ignoring brackets inside
 * strings and comments.
 *
 * The comment handling is not cosmetic: an apostrophe in `// the customer's
 * name` opens a string that never closes, after which every bracket counts as
 * quoted and the check silently passes. Two files in this tree contain exactly
 * that, and they are what made this assertion fail the first time it ran.
 */
function bracketsBalanced(src: string): boolean {
  return scan(src, () => false) === null;
}

/** True if `src` contains a `;` outside every bracket, string and comment. */
function hasTopLevelSemicolon(src: string): boolean {
  return scan(src, (ch, depth) => ch === ";" && depth === 0) === "hit";
}

/**
 * Single bracket/string/comment-aware pass, shared so the two checks above
 * cannot disagree about what counts as "inside a string".
 *
 * Returns "hit" if `predicate` fired, "unbalanced" if the brackets do not
 * close, or null for a clean balanced scan.
 */
function scan(src: string, predicate: (ch: string, depth: number) => boolean): "hit" | "unbalanced" | null {
  const stack: string[] = [];
  const pairs: Record<string, string> = { ")": "(", "]": "[", "}": "{" };
  let quote: string | null = null;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (src.startsWith("//", i)) {
      const nl = src.indexOf("\n", i);
      if (nl === -1) break;
      i = nl;
      continue;
    }
    if (src.startsWith("/*", i)) {
      const close = src.indexOf("*/", i);
      if (close === -1) break;
      i = close + 1;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") stack.push(ch);
    else if (ch === ")" || ch === "]" || ch === "}") {
      if (stack.pop() !== pairs[ch]) return "unbalanced";
    } else if (predicate(ch, stack.length)) {
      return "hit";
    }
  }
  return stack.length === 0 && quote === null ? null : "unbalanced";
}
