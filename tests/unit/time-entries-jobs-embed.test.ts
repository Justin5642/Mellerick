import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// time_entries points at jobs TWICE (job_id and travel_from_job_id, 0005), so
// PostgREST refuses a bare `jobs(...)` embed from time_entries with PGRST201
// ("more than one relationship was found"). Three reads did that from July to
// 15 Nov 2026 and failed every time: the hourly site-pin job, the dashboard's
// "still clocked on" list, and the phone's auto-clock site list fallback. Name
// the link: jobs!time_entries_job_id_fkey(...).

const ROOTS = ["app", "lib", "components", "mobile/lib", "mobile/app", "mobile/components"];

function files(dir: string, out: string[] = []): string[] {
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) files(p, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

describe("time_entries → jobs embeds name their link", () => {
  it("never embeds a bare jobs(...) from time_entries", () => {
    const bad: string[] = [];
    for (const f of ROOTS.flatMap((r) => files(r))) {
      const src = readFileSync(f, "utf8");
      const re = /\.from\(\s*["']time_entries["']\s*\)/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(src))) {
        // The select that follows this .from(), up to the next .from( or 600 chars.
        const rest = src.slice(m.index + m[0].length, m.index + m[0].length + 600);
        const sel = rest.split(/\.from\(/)[0].match(/\.select\(\s*(["'`])([\s\S]*?)\1/);
        if (sel && /(^|[\s,(])jobs(!inner)?\s*\(/.test(sel[2])) {
          bad.push(`${f}:${src.slice(0, m.index).split("\n").length}`);
        }
      }
    }
    expect(bad).toEqual([]);
  });
});
