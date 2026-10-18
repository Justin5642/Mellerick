import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";

// A server component that imports a VALUE from a "use client" module does not
// get the value. Next.js hands it a client reference instead. Components are
// fine (that is how client components are rendered from the server); a string,
// number or function used on the server is not.
//
// This shipped once: the Jobs page's server component imported its column list
// and a helper from components/jobs/jobs-list-client.tsx, passed the reference
// to .select(), and the Jobs page showed no jobs (18 Oct 2026). Type checks,
// the build and every unit test passed, because the types were fine.
//
// The rule enforced here: from a server file under app/, every name imported
// from a "use client" module must look like a component (PascalCase) or be a
// type-only import.

const ROOT = process.cwd();

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(join(ROOT, dir))) {
    const rel = join(dir, name);
    if (statSync(join(ROOT, rel)).isDirectory()) walk(rel, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(rel);
  }
  return out;
}

function isClientModule(spec: string): boolean {
  if (!spec.startsWith("@/")) return false;
  const base = join(ROOT, spec.slice(2));
  for (const ext of [".tsx", ".ts", "/index.tsx", "/index.ts"]) {
    if (existsSync(base + ext)) return /^\s*["']use client["']/.test(readFileSync(base + ext, "utf8"));
  }
  return false;
}

describe("server components only import components from client modules", () => {
  it("imports no plain values from a \"use client\" file into a server file", () => {
    const offenders: string[] = [];
    for (const file of walk("app")) {
      const src = readFileSync(join(ROOT, file), "utf8");
      if (/^\s*["']use client["']/.test(src)) continue;
      for (const m of src.matchAll(/import\s+(type\s+)?\{([^}]*)\}\s+from\s+["']([^"']+)["']/g)) {
        if (m[1] || !isClientModule(m[3])) continue;
        for (const raw of m[2].split(",")) {
          const name = raw.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0];
          if (!name || raw.trim().startsWith("type ")) continue;
          if (!/^[A-Z][a-z0-9]/.test(name)) offenders.push(`${file}: ${name} from ${m[3]}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("would have caught the Jobs page bug", () => {
    expect(/^[A-Z][a-z0-9]/.test("LIST_COLUMNS")).toBe(false);
    expect(/^[A-Z][a-z0-9]/.test("latestStageByJob")).toBe(false);
    expect(/^[A-Z][a-z0-9]/.test("JobsListClient")).toBe(true);
  });
});
