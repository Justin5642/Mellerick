import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// The Simpro import scripts once appended "Simpro total (inc tax): $…" to
// jobs.notes — a free-text column technicians see on the job page and in their
// sync stream — so 2,501 jobs showed their value to technicians (cleaned by
// migration 0072, applied 16 Oct 2026). Money COLUMNS are guarded four ways (HANDOVER §2); free
// text is not, so the writers themselves are checked here.
const SCRIPTS = ["scripts/migrate-simpro-jobs.mjs", "scripts/backfill-recent-simpro-jobs.mjs"];

function buildJobNotesBody(src: string): string {
  const start = src.indexOf("function buildJobNotes(");
  expect(start, "buildJobNotes not found — update this guard if it moved").toBeGreaterThan(-1);
  const end = src.indexOf("\n}\n", start);
  return src.slice(start, end);
}

describe("Simpro import scripts never write money into job notes", () => {
  for (const script of SCRIPTS) {
    it(script, () => {
      const body = buildJobNotesBody(readFileSync(join(process.cwd(), script), "utf8"));
      // Strip comments, which explain the rule and may name what is banned.
      const code = body.replace(/\/\/[^\n]*/g, "");
      expect(code).not.toMatch(/total|IncTax|ExTax|price|amount|\$\$\{/i);
    });
  }
});
