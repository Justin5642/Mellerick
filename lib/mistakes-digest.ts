// The Monday email's "Mistakes" line (0119, a draft not applied yet): how many were logged in the last
// 7 days, how many aren't closed, and the money claimed back but not yet
// received. Read with the service role by the cron route (it has no user).
// null = mistake tracking isn't switched on (the line is left out).

import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchAllRows } from "@/lib/fetch-all-rows";
import { isMissingColumn, isMissingTable, loadCostSources, loadMistakes, withMoney } from "@/lib/mistakes-data";
import { openRecoverable } from "@/lib/mistakes-report";
import { loadMistakePatterns } from "@/lib/mistake-patterns-data";
import { patternsForViewer, type PatternFlag } from "@/lib/mistake-patterns";
import { dateKeyInBusinessTZ } from "@/lib/date";
import type { DigestMistakePatterns, DigestMistakes } from "@/lib/weekly-digest";

/** How many patterns the email names. */
export const DIGEST_PATTERN_LIMIT = 3;

export async function loadMistakesForDigest(db: SupabaseClient, now: Date = new Date()): Promise<DigestMistakes | null> {
  const res = await fetchAllRows<{ raised_at: string | null; status: string; recovery_claimed_ex_gst: number | null; recovered_ex_gst: number | null }>(
    (count) => db.from("job_mistakes").select("id, raised_at, status, recovery_claimed_ex_gst, recovered_ex_gst", count).order("id") as never
  );
  if (!res.ok) {
    if (isMissingTable({ code: res.code }) || isMissingColumn({ code: res.code })) return null;
    throw new Error(res.error);
  }
  const summary = summariseDigestMistakes(res.rows, now);
  // Stage 5 pattern flags. Optional: a failure here never stops the line (or the email).
  try {
    const patterns = await loadPatternsForDigest(db, now);
    if (patterns) summary.patterns = patterns;
  } catch (err) {
    console.error("weekly digest: mistake patterns unavailable", err);
  }
  return summary;
}

/**
 * The pattern flags for the office email: never the admin-only "same person"
 * flag, and labour is costed as office sees it (no payroll rates — $0, hours
 * only). null before 0119 (no causes, categories or suppliers to group by).
 */
export async function loadPatternsForDigest(db: SupabaseClient, now: Date = new Date()): Promise<DigestMistakePatterns | null> {
  const loaded = await loadMistakes(db);
  if (loaded.mode !== "tracking") return null;
  if (loaded.error) throw new Error(loaded.error);
  const { sources } = await loadCostSources(db, loaded.lines, { withRates: false });
  const mistakes = withMoney(loaded.mistakes, loaded.lines, sources);
  const flags = await loadMistakePatterns(db, mistakes, { withPeople: false, today: dateKeyInBusinessTZ(now) });
  return summariseDigestPatterns(flags);
}

export function summariseDigestPatterns(flags: PatternFlag[]): DigestMistakePatterns {
  const shown = patternsForViewer(flags, false);
  return { count: shown.length, top: shown.slice(0, DIGEST_PATTERN_LIMIT).map((f) => ({ title: f.title, rule: f.rule, net: f.net })) };
}

export function summariseDigestMistakes(
  rows: { raised_at: string | null; status: string; recovery_claimed_ex_gst: number | null; recovered_ex_gst: number | null }[],
  now: Date
): DigestMistakes {
  const weekAgo = now.getTime() - 7 * 24 * 3600 * 1000;
  return {
    newThisWeek: rows.filter((r) => r.raised_at && Date.parse(r.raised_at) >= weekAgo).length,
    open: rows.filter((r) => r.status !== "closed").length,
    openRecoverable: openRecoverable(rows),
  };
}
