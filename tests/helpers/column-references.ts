// Extracted from tests/unit/schema-column-contract.test.ts (items N13, N14).
//
// WHY IT LIVES HERE. The contract test is a drift guard: it reads every source
// file and asserts that the columns the code names exist in the migration
// history. That makes its own extraction logic load-bearing — a bug here does
// not fail the suite, it silently narrows what the guard sees, and the guard
// stays green while the drift it exists to catch walks past. This repo has
// already been bitten by exactly that: a `[^t]` regex in migration 0053 matched
// the space inside the very form it was checking, so it fired on the policies
// that were already correct.
//
// A guard nobody tests is a guard nobody can trust. Pulling the parser out of
// the test file makes it directly testable, which is the only reason to move it.

const isSpace = (ch: string) => ch === " " || ch === "\t" || ch === "\n" || ch === "\r";
const isWord = (ch: string) => /[A-Za-z0-9_$]/.test(ch);

/**
 * If a comment starts at `i`, the index just past it; otherwise `i`.
 *
 * Every scanner here has to know about comments, and not for tidiness: an
 * apostrophe in a perfectly ordinary `// the customer's name` opens a string
 * that never closes, and from there every bracket in the file is "inside a
 * string" and the scan silently stops counting. Two files in this tree do
 * exactly that.
 */
function skipComment(src: string, i: number): number {
  if (src.startsWith("//", i)) {
    const nl = src.indexOf("\n", i);
    return nl === -1 ? src.length : nl + 1;
  }
  if (src.startsWith("/*", i)) {
    const close = src.indexOf("*/", i);
    return close === -1 ? src.length : close + 2;
  }
  return i;
}

/**
 * Index just past the `)` that closes the call opening at `open`.
 *
 * String-aware, because arguments contain parens: `.select("*, customers(name)")`
 * would otherwise close three characters early. Returns -1 if unterminated.
 */
export function callEnd(src: string, open: number): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = null;
      continue;
    }
    const past = skipComment(src, i);
    if (past !== i) {
      i = past - 1;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

/**
 * The text of the method chain that continues from `start`.
 *
 * N13 was reported as "the comment says ~600 chars, the code uses 400". Both
 * numbers were wrong — measured against this tree, chains run to 1592 chars and
 * 400 truncated 17 of the 383 present. But raising the number is the wrong fix,
 * and trying it proved why: at 1600 the scan ran past the end of
 * `.from("jobs")…single()` in app/api/jobs/[id]/sync-calendar/route.ts and into
 * `calendar.events.update({ calendarId, eventId, requestBody })` — the GOOGLE
 * client — and reported calendarId, eventId and requestBody as missing `jobs`
 * columns.
 *
 * A character window cannot tell a chain from what follows it, so every value
 * is either too small (silent under-coverage) or too large (false positives).
 * There is no good number, which is why the comment and the code could disagree
 * for so long without either being right.
 *
 * So follow the chain instead. After `.from(…)` a Supabase chain is a run of
 * `.method(...)` continuations and ends at the first thing that is not one.
 * That is exact, needs no window, and stops dead at the `;` after `.single()`.
 */
export function chainAfter(src: string, start: number): string {
  let i = start;
  for (;;) {
    // Skip whitespace and comments between links — chains are written across
    // lines and are occasionally annotated mid-chain.
    for (;;) {
      while (i < src.length && isSpace(src[i])) i++;
      const past = skipComment(src, i);
      if (past === i) break;
      if (past >= src.length) return src.slice(start, i);
      i = past;
    }

    // `.method(` or `?.method(` — anything else ends the chain.
    let j = i;
    if (src[j] === "?") j++;
    if (src[j] !== ".") return src.slice(start, i);
    j++;
    while (j < src.length && isSpace(src[j])) j++;
    const nameStart = j;
    while (j < src.length && isWord(src[j])) j++;
    if (j === nameStart) return src.slice(start, i);
    const method = src.slice(nameStart, j);
    // A second `.from(` is a different table's chain. Consuming it would
    // attribute that table's columns to this one — a real source of false
    // positives, and the reason the original scan stopped here too.
    if (method === "from") return src.slice(start, i);
    while (j < src.length && isSpace(src[j])) j++;
    if (src[j] !== "(") return src.slice(start, i);

    const end = callEnd(src, j);
    if (end === -1) return src.slice(start, i);
    i = end;
  }
}

/**
 * Extract the body of an object literal starting at `open` (the index of `{`),
 * balancing braces so nested objects do not end it early.
 *
 * N14: the previous `\{([^}]*)\}` stopped at the FIRST `}`. Every key after a
 * nested object was invisible — `.update({ meta: { a: 1 }, ready_to_invoice: x })`
 * yielded `meta` and nothing else, so the guard could not see the very column
 * whose absence from the schema is the bug this whole file exists to catch.
 *
 * Strings are tracked so a brace inside one (`'}'`, a template literal) does
 * not unbalance the count. Returns null for an unterminated literal rather than
 * guessing.
 */
export function objectLiteralBody(src: string, open: number): string | null {
  let depth = 0;
  let quote: string | null = null;
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = null;
      continue;
    }
    const past = skipComment(src, i);
    if (past !== i) {
      i = past - 1;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return src.slice(open + 1, i);
    }
  }
  return null;
}

/**
 * Column references tied to a table, e.g. `.from("jobs")…update({ ready_to_invoice: … })`.
 *
 * Sees three shapes: filter arguments (`.eq("col", …)`), object-literal keys in
 * a write (`.update({ col: … })`), and SHORTHAND keys (`{ hours, entry_type }`).
 * The last is not hypothetical — the geofence auto-clock wrote `hours` exactly
 * that way and the colon-only pattern walked past it for months.
 *
 * Only top-level keys of a write payload count. A nested object's keys belong to
 * a JSON column's interior, not to the table, so counting them would invent
 * columns that were never claimed to exist.
 */
export function referencedColumns(src: string, table: string): Set<string> {
  const found = new Set<string>();
  const fromRe = new RegExp(`\\.from\\(\\s*["'\`]${table}["'\`]\\s*\\)`, "g");

  for (const m of src.matchAll(fromRe)) {
    const chunk = chainAfter(src, m.index! + m[0].length);

    for (const [, col] of chunk.matchAll(/\.(?:eq|neq|gt|gte|lt|lte|is|in|order)\(\s*["'`](\w+)["'`]/g)) {
      found.add(col);
    }

    for (const om of chunk.matchAll(/\.(?:update|insert|upsert)\(\s*\{/g)) {
      const body = objectLiteralBody(chunk, chunk.indexOf("{", om.index!));
      if (body === null) continue;
      for (const key of topLevelKeys(body)) found.add(key);
    }
  }
  return found;
}

/**
 * Keys at depth 0 of an object-literal body, both `col: value` and shorthand.
 *
 * Walks rather than regexes because the depth has to be tracked: a regex over
 * the whole body would pick up the keys of nested objects, which are not
 * columns.
 */
function topLevelKeys(body: string): string[] {
  const keys: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let segmentStart = 0;

  const takeSegment = (end: number) => {
    const seg = body.slice(segmentStart, end);
    // `col: value` — the key is what precedes the first colon.
    const withValue = seg.match(/^\s*(\w+)\s*:/);
    if (withValue) {
      keys.push(withValue[1]);
      return;
    }
    // Shorthand — the whole segment is a bare identifier. A spread (`...rest`)
    // names no column and is deliberately not matched.
    const shorthand = seg.match(/^\s*(\w+)\s*$/);
    if (shorthand) keys.push(shorthand[1]);
  };

  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === "{" || ch === "[" || ch === "(") depth++;
    else if (ch === "}" || ch === "]" || ch === ")") depth--;
    else if (ch === "," && depth === 0) {
      takeSegment(i);
      segmentStart = i + 1;
    }
  }
  takeSegment(body.length);
  return keys;
}
