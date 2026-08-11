// Read the rows out of `supabase db query`, whichever shape it decided to use.
//
// WHY THIS IS A SHARED MODULE AND NOT A LINE IN EACH SCRIPT
// check-sync-health.mjs and check-migrations.mjs each grew their own copy of
// this parse. Both copies were written against the piped envelope, so both
// carried the same defect, and fixing one would have left the other broken —
// which is what happened.
//
// THE SHAPES, MEASURED (CLI 2.113.0, live linked project, 2026-08-12)
//
//   flags                  piped / --agent yes      real terminal / --agent no
//   (none)                 {boundary, rows:[...]}   box-drawing TABLE
//   --output json          {boundary, rows:[...]}   bare array [{...}]
//   --output-format json   {boundary, rows:[...]}   bare array [{...}]
//
// Read that table twice: NO flag combination produces one shape in both modes.
// The CLI auto-detects whether it is talking to an agent — from how the process
// is attached — and agent detection outranks the format flag. `--output-format
// json` is still needed, because it is what turns the interactive case from an
// unparseable table into a bare array. It just does not make the two modes
// agree, and a comment in this repo claimed it did.
//
// So the shape cannot be forced, and this parser accepts BOTH JSON forms.
//
// WHY IT REFUSES THE TABLE INSTEAD OF SCRAPING IT
// The table is parseable in principle — the cell holds the JSON. Scraping it
// would mean matching box-drawing characters and column widths, and getting a
// silently truncated value on the day a column is wide enough to wrap. Every
// caller here uses the result to decide whether something is WRONG, and each
// one's empty answer is a confident falsehood: "no replication slot exists"
// for the health check, "production has applied no migrations" for the ledger.
// Refusing is the only failure that cannot be mistaken for a finding.
//
// HOW THIS BUG GOT IN, since the shape of the mistake matters more than the fix
// The scripts were developed by piping their output to read it. Piping is what
// selects the agent shape. So the one thing that could have caught this — run
// it and look — was also the thing that guaranteed it stayed hidden, and the
// first human to run the command got the shape nothing had ever parsed.

/** How much raw output to quote back in an error. Enough to identify the shape. */
const EVIDENCE_CHARS = 400;

function evidence(text) {
  const head = text.length > EVIDENCE_CHARS ? `${text.slice(0, EVIDENCE_CHARS)}…` : text;
  return head.trim() === "" ? "(the CLI produced no output at all)" : head;
}

/**
 * The row objects from a `supabase db query` invocation.
 *
 * Accepts the agent envelope ({ boundary, rows, warning }) and the bare array
 * of rows. Throws on the human table, on non-JSON, and on JSON that is neither
 * shape — always with the raw output attached, because the failure this
 * replaced reported only "Unexpected non-whitespace character after JSON at
 * position 116" and never said what had actually arrived.
 *
 * An EMPTY result set is returned as [], not thrown. What emptiness means is
 * the caller's to decide: the ledger check must refuse it, the health check
 * must report it as an outage.
 */
export function parseCliRows(out) {
  const text = String(out);

  // The CLI prints a status line ("Initialising login role...") before the
  // payload, so the payload starts at the first `{` or `[` — whichever comes
  // first. Taking `{` alone is precisely the bug: inside a bare array the first
  // `{` is the first ROW, and parsing from there runs into the array's `]`.
  const brace = text.indexOf("{");
  const bracket = text.indexOf("[");
  const candidates = [brace, bracket].filter((i) => i !== -1);

  if (candidates.length === 0) {
    throw new Error(`the Supabase CLI produced no JSON at all. It said:\n${evidence(text)}`);
  }
  const start = Math.min(...candidates);

  let payload;
  try {
    payload = JSON.parse(text.slice(start));
  } catch (e) {
    // The table lands here: its first `[` is inside a cell, so the slice parses
    // one value and then meets the cell's closing border. Name it, because
    // "Unexpected non-whitespace character after JSON" describes the symptom
    // and gives the reader nothing to act on.
    const looksLikeTable = /[┌┐└┘├┤│─]/.test(text);
    const hint = looksLikeTable
      ? "That is the CLI's human TABLE format, which this cannot read. It is emitted when the CLI thinks it is talking to a person rather than an agent — pass `--output-format json`."
      : `The output could not be parsed as JSON (${String(e.message || e)}).`;
    throw new Error(`${hint}\n\nWhat the CLI actually produced:\n${evidence(text)}`);
  }

  if (Array.isArray(payload)) return payload;

  if (payload && typeof payload === "object") {
    if (Array.isArray(payload.rows)) return payload.rows;
    throw new Error(
      `the Supabase CLI returned a JSON object with no \`rows\` array, so there is nothing to read.\n\n${evidence(text)}`
    );
  }

  // `JSON.parse("123")` succeeds. Without this, a scalar would travel onward as
  // if it were rows and fail somewhere with no connection to its cause.
  throw new Error(`expected rows from the Supabase CLI, got ${typeof payload}.\n\n${evidence(text)}`);
}

/**
 * The single aggregate column both callers select, already JSON-parsed.
 *
 * Every query here is `select coalesce(json_agg(...)...)::text`, one row and one
 * column whose name depends on the expression — so it is taken positionally
 * rather than by name.
 */
export function singleJsonColumn(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return null;

  const values = Object.values(rows[0]);
  if (values.length === 0 || typeof values[0] !== "string") {
    throw new Error(`unexpected result shape from the Supabase CLI: ${JSON.stringify(rows[0])}`);
  }
  return JSON.parse(values[0]);
}
