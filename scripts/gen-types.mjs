#!/usr/bin/env node
// Regenerates lib/database.types.ts from Postgres (item 3.3).
//
//   npm run gen:types            # from the linked hosted project
//   npm run gen:types -- --local # from a running `supabase start` stack
//
// WHY A SCRIPT AND NOT A LINE IN package.json. Two things have to happen that a
// single CLI call does not do: the output needs a header saying it is generated
// (the CLI emits none, and an unmarked 2000-line file gets hand-edited sooner or
// later), and the write has to be refused when the CLI produced nothing useful.
// `supabase gen types … > file` truncates the target BEFORE the command runs, so
// a failure leaves an empty file that still compiles as a module and quietly
// turns every table type into `any`. Generating to memory and checking first is
// the whole reason this is a script.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(REPO, "lib", "database.types.ts");

const local = process.argv.includes("--local");
const source = local ? ["--local"] : ["--linked"];

const HEADER = `// GENERATED FILE — do not edit by hand.
// Regenerate: npm run gen:types            (linked project)
//             npm run gen:types -- --local (running \`supabase start\` stack)
//
// The Postgres schema as TypeScript. Its value is not documentation — it is that
// a column name typed wrong stops compiling instead of failing at runtime, which
// is how jobs.ready_to_invoice reached production referenced by nine call sites
// and existing in no database.
//
// tests/unit/database-types-freshness.test.ts fails the build when a migration
// adds something this file has not caught up with, so a stale copy cannot sit
// here looking authoritative.

`;

console.log(`Generating types (${local ? "local stack" : "linked project"})…`);
let generated;
try {
  // `shell: true` is required, not stylistic: since Node 20 a bare
  // execFileSync of a Windows .cmd shim fails with EINVAL, which is what
  // `npx.cmd` is. Every argument here is a fixed literal — no interpolation,
  // nothing user-supplied — so handing them to a shell introduces nothing.
  generated = execFileSync(
    "npx supabase gen types typescript " + source.join(" ") + " --schema public",
    { cwd: REPO, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, shell: true }
  );
} catch (e) {
  console.error("supabase gen types failed:\n" + (e.stderr || e.message));
  process.exit(1);
}

// The CLI prints progress to stderr and JSON errors to stdout on some failures,
// so "it exited 0" is not enough. Refuse anything that is not recognisably the
// types module rather than overwriting a good file with a bad one.
if (!generated.includes("export type Database") || generated.length < 2000) {
  console.error(
    `Refusing to write ${OUT}: the CLI returned ${generated.length} bytes with no ` +
      `\`export type Database\`. The existing file has been left alone.`
  );
  process.exit(1);
}

const next = HEADER + generated.trimStart();
const current = (() => {
  try {
    return readFileSync(OUT, "utf8");
  } catch {
    return "";
  }
})();

if (next === current) {
  console.log(`${OUT} already up to date.`);
  process.exit(0);
}

writeFileSync(OUT, next);
const tables = (generated.match(/\n {6}\w+: \{\n {8}Row: \{/g) ?? []).length;
console.log(`wrote ${OUT} — ${tables} tables`);
