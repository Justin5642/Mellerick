import { describe, it, expect } from "vitest";
import { compare, versionOf, parseLedger } from "../../scripts/check-migrations.mjs";

// WHY THIS TEST EXISTS
//
// `npm run check:migrations` was cited as a live guard — by
// tests/unit/migration-header-truth.test.ts, by HANDOVER-HARDENING.md, and by
// the header of every one of 0049..0053 — for weeks before it was written.
// Nothing enforced the `STATUS: DRAFT — NOT APPLIED` claim those five files
// make about themselves.
//
// Now that it exists, it has the same shape as check-sync-health: the path that
// says "all fine" runs every time and proves itself, while the paths that
// report a lie only run on the day someone applies a migration and forgets its
// header. That day is the worst possible moment to discover a typo in them, and
// the script cannot be run in CI at all — CI holds no production credentials.
// So the comparison is a pure function, and it is exercised here.

const draft = (file: string) => ({ file, claimsNotApplied: true, claimsApplied: false });
const claimsLive = (file: string) => ({ file, claimsNotApplied: false, claimsApplied: true });
const silent = (file: string) => ({ file, claimsNotApplied: false, claimsApplied: false });

describe("versionOf", () => {
  it("takes the leading digits, which is what the ledger records", () => {
    expect(versionOf("0049_scope_job_media_delete_to_the_job.sql")).toBe("0049");
    expect(versionOf("0000_baseline.sql")).toBe("0000");
  });

  it("returns null for a file the CLI would not treat as a migration", () => {
    // `supabase db push` derives the version from the filename. A file that
    // does not carry one is never recorded, so it can never be compared —
    // saying so beats silently treating it as unapplied forever.
    expect(versionOf("notes.sql")).toBeNull();
  });
});

describe("comparing headers against the ledger", () => {
  it("is silent about a draft the ledger has never seen — the expected state", () => {
    const r = compare({ files: [draft("0049_x.sql")], applied: [] });
    expect(r.problems).toEqual([]);
    expect(r.pending.map((p) => p.file)).toEqual(["0049_x.sql"]);
  });

  it("REPORTS a draft the ledger says is applied", () => {
    // The headline case, and the one every citation promised. 0049..0053 each
    // say the build fails if that line is still there once the migration IS
    // applied. This is where that becomes true.
    const r = compare({ files: [draft("0049_x.sql")], applied: ["0049"] });
    expect(r.problems).toHaveLength(1);
    expect(r.problems[0].kind).toBe("stale-draft-header");
    expect(r.problems[0].version).toBe("0049");
  });

  it("REPORTS a header claiming production when the ledger lacks it", () => {
    // The 0035/0036/0038 failure in the other direction: a header asserting the
    // dollar-leak boundary is in force when nothing has applied it.
    const r = compare({
      files: [silent("0000_baseline.sql"), claimsLive("0035_x.sql")],
      applied: ["0000"],
    });
    expect(r.problems.map((p) => p.kind)).toEqual(["unapplied-claim"]);
    expect(r.problems[0].file).toBe("0035_x.sql");
  });

  it("says nothing about a file that makes no claim and is not applied", () => {
    // Most migrations state no status. A file that claims nothing cannot be
    // caught lying, and failing the build for every freshly written migration
    // is how a guard gets deleted rather than obeyed.
    const r = compare({ files: [silent("0054_new.sql")], applied: [] });
    expect(r.problems).toEqual([]);
    expect(r.pending.map((p) => p.file)).toEqual(["0054_new.sql"]);
  });

  it("says nothing about a file that makes no claim and IS applied", () => {
    const r = compare({ files: [silent("0000_baseline.sql")], applied: ["0000"] });
    expect(r.problems).toEqual([]);
    expect(r.pending).toEqual([]);
  });

  it("REPORTS a version the ledger holds with no file in the repo", () => {
    // Something was applied to production that this repo cannot rebuild. That
    // is the drift class check:drift exists for, seen from the ledger side.
    const r = compare({ files: [silent("0000_baseline.sql")], applied: ["0000", "20260810120000"] });
    expect(r.problems.map((p) => p.kind)).toEqual(["applied-without-file"]);
    expect(r.problems[0].version).toBe("20260810120000");
  });

  it("REPORTS a migration file carrying no version", () => {
    const r = compare({ files: [silent("baseline.sql")], applied: [] });
    expect(r.problems.map((p) => p.kind)).toEqual(["unversioned-file"]);
  });

  it("cannot return a clean result from an empty ledger while headers claim production", () => {
    // A read that silently produced nothing must not read as "every header is
    // honest". The reader refuses an empty ledger outright; this pins that even
    // if it ever stopped refusing, the comparison itself would not go quiet.
    const r = compare({ files: [claimsLive("0035_x.sql"), draft("0049_x.sql")], applied: [] });
    expect(r.problems).not.toEqual([]);
  });

  it("reports every offender, not just the first", () => {
    const r = compare({
      files: [draft("0049_x.sql"), draft("0050_y.sql"), claimsLive("0035_z.sql")],
      applied: ["0049", "0050"],
    });
    expect(r.problems).toHaveLength(3);
  });
});

describe("parseLedger", () => {
  // The CLI prints a status line and then a JSON envelope
  // ({ boundary, rows: [...] }) — the same shape check-sync-health.mjs parses,
  // and for the same reason: grabbing the first bracket finds the envelope's
  // own array, not the query result.
  const envelope = (payload: string) =>
    `Initialising login role...\n{"boundary":"x","rows":[{"versions":${JSON.stringify(payload)}}],"warning":""}`;

  it("reads the versions out of the CLI's envelope", () => {
    expect(parseLedger(envelope('["0000","0001"]'))).toEqual(["0000", "0001"]);
  });

  it("REFUSES the Supabase CLI's table output instead of mis-reading it", () => {
    // The bug this pins, found by a human running the script in PowerShell
    // while it had worked every time I ran it: the Supabase CLI renders a
    // box-drawing TABLE when attached to an interactive terminal and JSON when
    // piped. So the script parsed correctly under a pipe and failed in a real
    // terminal — an environment-dependent bug invisible to the way it was
    // developed. Fixed by passing `--output json`, which makes the format
    // independent of how the process is attached.
    //
    // The parser's behaviour on the table form still matters, because a future
    // CLI could change again. It must THROW. Quietly returning [] would report
    // "0 migrations applied", and compare() would then call every applied
    // migration pending — a confident, wrong answer, which is worse than the
    // failure it replaced.
    const table = `┌───────────┐
│ versions  │
├───────────┤
│ ["0000", "0001", "0002"] │
└───────────┘`;

    expect(() => parseLedger(table)).toThrow();
  });

  it("throws rather than returning nothing when the output is not what it expects", () => {
    // Returning [] here would present as "the ledger is empty", and an empty
    // ledger compared against a repo of drafts reports no stale headers at all.
    expect(() => parseLedger("supabase: command not found")).toThrow();
    expect(() => parseLedger('{"boundary":"x","rows":[],"warning":""}')).toThrow();
  });

  it("refuses an empty ledger instead of reporting every header honest", () => {
    // 0000_baseline is in production by definition — this database exists. An
    // empty version list means the query reached the wrong place, and against
    // an empty ledger no draft header can be caught being stale.
    expect(() => parseLedger(envelope("[]"))).toThrow(/empty/i);
  });
});
