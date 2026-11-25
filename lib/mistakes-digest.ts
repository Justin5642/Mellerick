// The Monday email's "Mistakes" line (0119, a draft not applied yet): how many were logged in the last
// 7 days, how many aren't closed, and the money claimed back but not yet
// received. Read with the service role by the cron route (it has no user).
// null = mistake tracking isn't switched on (the line is left out).

import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchAllRows } from "@/lib/fetch-all-rows";
import { isMissingColumn, isMissingTable } from "@/lib/mistakes-data";
import { openRecoverable } from "@/lib/mistakes-report";
import type { DigestMistakes } from "@/lib/weekly-digest";

export async function loadMistakesForDigest(db: SupabaseClient, now: Date = new Date()): Promise<DigestMistakes | null> {
  const res = await fetchAllRows<{ raised_at: string | null; status: string; recovery_claimed_ex_gst: number | null; recovered_ex_gst: number | null }>(
    (count) => db.from("job_mistakes").select("id, raised_at, status, recovery_claimed_ex_gst, recovered_ex_gst", count).order("id") as never
  );
  if (!res.ok) {
    if (isMissingTable({ code: res.code }) || isMissingColumn({ code: res.code })) return null;
    throw new Error(res.error);
  }
  return summariseDigestMistakes(res.rows, now);
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
