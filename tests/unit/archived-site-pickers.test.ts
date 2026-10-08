import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

// Archived sites (sites.is_active = false, migration 0063) stay attached to the
// jobs/devices that already use them, but must never be OFFERED for a new
// record. Every UI that loads a customer's sites to fill a picker therefore
// filters on is_active — either `.eq("is_active", true)`, or, when editing an
// existing record, `.or(\`is_active.eq.true,id.eq.${currentId}\`)` so that
// record's own (possibly archived) site stays selectable (job-overview.tsx).
//
// This guard fails when a new `.from("sites")…select(…)` read appears without
// an is_active filter. If the new read is genuinely display-only (history must
// keep showing archived sites), add the file to DISPLAY_ONLY with the reason.

const ROOT = join(__dirname, "..", "..");
const SCAN_DIRS = ["app", "components", "lib", "mobile/app", "mobile/components", "mobile/lib"];

// path -> why its `sites` read is not a picker for a new record.
const DISPLAY_ONLY: Record<string, string> = {
  "app/dashboard/jobs/page.tsx": "jobs list search — finds jobs at any site, archived included",
  "app/dashboard/customers/[id]/page.tsx": "customer page lists every site with an archive/restore button",
};

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(full);
  }
  return out;
}

/** Each `.from("sites")` chain, up to the end of its statement. */
function siteReadChains(src: string): string[] {
  const chains: string[] = [];
  const re = /\.from\(\s*["']sites["']\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const rest = src.slice(m.index);
    const end = rest.search(/;|\.then\(/);
    const chain = end === -1 ? rest.slice(0, 600) : rest.slice(0, end);
    // Writes (insert/update/delete — even with a trailing .select()) are not pickers.
    if (/\.(insert|update|upsert|delete)\(/.test(chain)) continue;
    if (!/\.select\(/.test(chain)) continue;
    chains.push(chain);
  }
  return chains;
}

describe("archived sites are not offered in site pickers", () => {
  const files = SCAN_DIRS.flatMap((d) => walk(join(ROOT, d)));

  it("every non-display `sites` read filters on is_active", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const rel = relative(ROOT, file).split("\\").join("/");
      if (rel in DISPLAY_ONLY) continue;
      const src = readFileSync(file, "utf8");
      for (const chain of siteReadChains(src)) {
        // job-overview's `let query = …from("sites")…;` adds the filter on the
        // next statement, so also accept is_active within the following lines.
        const idx = src.indexOf(chain);
        const window = src.slice(idx, idx + chain.length + 400);
        if (!/is_active/.test(window)) offenders.push(`${rel}: ${chain.replace(/\s+/g, " ").slice(0, 120)}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("finds the known pickers (the scan is not vacuous)", () => {
    const withReads = files
      .filter((f) => siteReadChains(readFileSync(f, "utf8")).length > 0)
      .map((f) => relative(ROOT, f).split("\\").join("/"));
    for (const known of [
      "app/dashboard/jobs/new/page.tsx",
      "app/dashboard/backflow/new/page.tsx",
      "components/job/job-overview.tsx",
      "mobile/app/backflow/new.tsx",
    ]) {
      expect(withReads).toContain(known);
    }
  });

  it("mobile new-job filters the customer's sites to active ones", () => {
    // mobile/app/jobs/new.tsx reads sites through getCustomer() (which must
    // return archived sites too, for the customer screen), so the filter lives
    // at the call site.
    const src = readFileSync(join(ROOT, "mobile/app/jobs/new.tsx"), "utf8");
    const uses = src.match(/setSites\([^;]*\);/g) ?? [];
    expect(uses.length).toBeGreaterThan(0);
    for (const u of uses) expect(u).toMatch(/is_active/);
  });
});
