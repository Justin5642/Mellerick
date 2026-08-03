import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Keep the evidence when a run FAILS.
//
// Q29 is a ~1-in-20 intermittent in the web suite. The JSON reporter writes to
// one fixed path, so the next run overwrites it — and the next run is exactly
// what you do when you see a failure scroll past. On 2026-08-04 the suite failed
// 1/195 and re-running it to read the failure destroyed the only record. That is
// the third time this intermittent has escaped identification.
//
// FIRST ATTEMPT, AND WHY IT DID NOT WORK: a globalTeardown hook that copied the
// report file. It archived nothing, because teardown runs before the JSON
// reporter has finished writing — so it read a stale or absent file. A negative
// control (a deliberately failing test) caught that; without it this would have
// looked installed and done nothing, which is the same failure mode as the
// swallowed errors elsewhere in this codebase.
//
// This reporter has the results in memory and depends on no file written by
// anyone else, so there is no ordering to get wrong.

interface VitestTask {
  name?: string;
  type?: string;
  result?: { state?: string; errors?: { message?: string; stack?: string }[] };
  tasks?: VitestTask[];
}

interface VitestFile extends VitestTask {
  filepath?: string;
}

function collectFailures(tasks: VitestTask[] | undefined, trail: string[], out: { test: string; error: string }[]) {
  for (const t of tasks ?? []) {
    const path = [...trail, t.name ?? "?"];
    if (t.result?.state === "fail") {
      const errs = t.result.errors ?? [];
      // Only leaf tests carry the assertion; suites just propagate the state.
      if (!t.tasks || t.tasks.length === 0 || errs.length > 0) {
        out.push({
          test: path.join(" > "),
          error: errs.map((e) => e.message ?? "").join("\n") || "(no message)",
        });
      }
    }
    collectFailures(t.tasks, path, out);
  }
}

export default class FailureArchiveReporter {
  onFinished(files: VitestFile[] = []) {
    const failures: { test: string; error: string }[] = [];
    for (const f of files) {
      collectFailures([f], [], failures);
    }
    if (failures.length === 0) return;

    const dir = join(process.cwd(), "test-results", "failures");
    mkdirSync(dir, { recursive: true });

    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const dest = join(dir, `unit-${stamp}.json`);
    writeFileSync(dest, JSON.stringify({ recordedAt: stamp, failures }, null, 2), "utf8");

    console.error(`\n  ${failures.length} failure(s) archived to test-results/failures/unit-${stamp}.json`);
    for (const f of failures) console.error(`    ${f.test}`);
    console.error(`  This record survives the next run — read it BEFORE re-running (Q29).\n`);
  }
}
