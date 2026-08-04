import { readFileSync, readdirSync } from "fs";
import { join } from "path";

// THE GUARD FOR THE BUG CLASS, not for one instance of it.
//
// On 2026-08-03 the Staff admin screen was found to have NEVER worked. The read
// was written as:
//
//     const { data } = await supabase.from("profiles").select(...);
//     return (data as unknown as StaffMember[]) ?? [];
//
// PostgREST returned PGRST201 (ambiguous embed — two FKs to the same table).
// `error` was never bound, so `data` was null and the caller got []. The screen
// rendered "No staff." to an admin with seven staff, and had done so forever.
//
// Writing 78 individual tests for 78 call sites would prove those 78 sites are
// right TODAY and say nothing about the 79th. This asserts the property instead:
// no read module may destructure a Supabase result without binding `error`.
//
// Why the shape and not the behaviour: the behaviour ("show an error") lives in
// screens and differs per screen. The invariant that makes all of those possible
// is that the error is not discarded at the seam. That is checkable here, cheaply,
// forever.

const READS_DIR = join(__dirname);

// unwrap.ts is the seam itself, and its doc comment QUOTES the bad pattern in
// order to explain it. Scanning it flags its own explanation forever — a guard
// that cannot be satisfied gets deleted, not obeyed. The seam has its own tests
// (unwrap.test.ts); this file's job is the CALLERS.
const NOT_A_CALLER = new Set(["unwrap.ts", "source.ts", "rowMap.ts"]);

function readModules(): { name: string; source: string }[] {
  return readdirSync(READS_DIR)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && !f.endsWith(".d.ts"))
    .filter((f) => !NOT_A_CALLER.has(f))
    .map((name) => ({ name, source: readFileSync(join(READS_DIR, name), "utf8") }));
}

// `const { data } = await <anything>` — the error is not in the destructuring
// pattern at all, so it cannot be checked. Allows `{ data, error }`,
// `{ error, data }`, and `{ data: rows, error }`.
//
// Deliberately `await \w+` and not `await supabase`: two live sites survived the
// narrower version by awaiting a BUILDER variable instead —
// `let builder = supabase.from(...); ...; const { data } = await builder;`
// which is the same query and the same discarded error, spelled differently.
const DESTRUCTURE = /const\s*\{([^}]*\bdata\b[^}]*)\}\s*=\s*await\s+\w+/g;

function lineOf(source: string, index: number): number {
  return source.slice(0, index).split("\n").length;
}

describe("read modules never discard a Supabase error", () => {
  it("binds `error` in every destructured supabase result", () => {
    const offenders: string[] = [];

    for (const { name, source } of readModules()) {
      for (const m of source.matchAll(DESTRUCTURE)) {
        const bound = m[1];
        if (!/\berror\b/.test(bound)) {
          offenders.push(`${name}:${lineOf(source, m.index ?? 0)} — const {${bound.trim()}} = await supabase…`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  // The second half of the same bug: even with `error` bound, returning
  // `data ?? []` on the failure path re-swallows it. Every read module must
  // route its result through the unwrap seam, which throws with context.
  it("routes results through unwrap/unwrapRows in every module that queries supabase", () => {
    const missing: string[] = [];

    for (const { name, source } of readModules()) {
      if (!/await\s+supabase/.test(source)) continue; // module does not query at all
      if (!/\bunwrap(Rows)?\s*\(/.test(source)) {
        missing.push(`${name} queries supabase but never calls unwrap/unwrapRows`);
      }
    }

    expect(missing).toEqual([]);
  });

  // The hole the first two tests did NOT close, found the hard way.
  //
  // Both checks above passed while eight live sites still discarded errors,
  // because those sites never wrote `const { data } = await supabase`. They came
  // from Promise.all and read the field off the result object instead:
  //
  //     const [profilesRes, equipRes] = await Promise.all([...]);
  //     return { staffCostProfiles: (profilesRes.data as unknown as P[]) ?? [] };
  //
  // Same bug, different spelling — and a guard that only recognises one spelling
  // is how the ninth spelling ships. The real invariant is simpler and has no
  // spellings: a read module never touches `.data` at all. Reaching into a
  // result means reaching PAST the error, every time. `unwrap` is the only place
  // allowed to do it, and it is excluded from this scan.
  it("never reads `.data` off a result directly — that is reaching past the error", () => {
    const offenders: string[] = [];

    for (const { name, source } of readModules()) {
      for (const m of source.matchAll(/(\w+)\.data\b/g)) {
        // `res.data` inside an unwrap argument is fine; this catches bare reads.
        offenders.push(`${name}:${lineOf(source, m.index ?? 0)} — ${m[1]}.data`);
      }
    }

    expect(offenders).toEqual([]);
  });

  // The THIRD spelling, and the reason this file keeps growing.
  //
  // `select("*", { count: "exact", head: true })` returns a count and NO data,
  // so it slipped past both checks above. The reports dashboard read it as
  // `jobCounts[i].count ?? 0`, meaning a failed per-status count rendered as
  // "0 jobs" — a plausible number on a management screen, and wrong in the way
  // that gets believed rather than questioned.
  //
  // Three spellings of one bug have now been found, each by looking again after
  // declaring the previous sweep complete. The lesson is not "add a fourth
  // pattern": it is that a swallowed error can wear any shape a Supabase result
  // has fields, so every field access on a result belongs behind the seam.
  it("never reads `.count` off a result directly — a failed count is not zero", () => {
    const offenders: string[] = [];

    // Narrower than the `.data` check, deliberately. `count` is also an ordinary
    // domain field here — `jobsByStatus` is `{ status, count }[]`, and flagging
    // `j.count` on a plain object would make this guard cry wolf until someone
    // deleted it. So: only result-shaped identifiers, and only where the line is
    // not already routed through the seam.
    const RESULT_ISH = /\b(\w*(?:Res|Result|Counts))\s*(?:\[[^\]]*\])?\s*\.count\b/g;

    for (const { name, source } of readModules()) {
      const lines = source.split("\n");
      for (const m of source.matchAll(RESULT_ISH)) {
        const lineNo = lineOf(source, m.index ?? 0);
        if (lines[lineNo - 1]?.includes("unwrapCount")) continue;
        offenders.push(`${name}:${lineNo} — ${m[0].trim()}`);
      }
    }

    expect(offenders).toEqual([]);
  });
});
