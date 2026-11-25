// The crew's view of mistakes on a job (GET/POST /api/jobs/[id]/mistakes):
// what the "Log mistake" form needs and the mistakes the caller raised. Every
// answer is built field by field from money-free columns — the crew never see
// a dollar figure (tests/unit/mistakes-routes.test.ts walks it).

import type { SupabaseClient } from "@supabase/supabase-js";
import type { JobStage } from "@/lib/builder-po-stages";
import type { MyMistake } from "@/lib/mistake-raise";

export interface CrewMistakeState {
  /** False before 0119 (a draft, not applied yet) is applied: logging isn't switched on yet. */
  ready: boolean;
  categories: { id: string; name: string }[];
  stages: { id: string; name: string; completed: boolean }[];
  /** The caller's own work time on this job, newest first (to mark as rework). */
  timeEntries: { id: string; clockIn: string; clockOut: string | null; hours: number | null }[];
  mistakes: MyMistake[];
}

const MISSING = new Set(["42883", "PGRST202", "42P01", "PGRST205", "42703", "PGRST204"]);

export async function loadCrewMistakeState(db: SupabaseClient, jobId: string, userId: string, stages: JobStage[]): Promise<CrewMistakeState> {
  const [cats, mine, times] = await Promise.all([
    db.from("mistake_categories").select("id, name, sort_order").eq("is_active", true).order("sort_order").order("name"),
    db.rpc("my_job_mistakes", { p_job_id: jobId }),
    db
      .from("time_entries")
      .select("id, clock_in, clock_out, hours")
      .eq("job_id", jobId)
      .eq("staff_id", userId)
      .eq("entry_type", "work")
      .order("clock_in", { ascending: false })
      .limit(60),
  ]);
  const notReady = (cats.error && MISSING.has(cats.error.code ?? "")) || (mine.error && MISSING.has(mine.error.code ?? ""));
  if (notReady) return { ready: false, categories: [], stages: [], timeEntries: [], mistakes: [] };
  if (cats.error) throw new Error(`mistake_categories: ${cats.error.message}`);
  if (mine.error) throw new Error(`my_job_mistakes: ${mine.error.message}`);
  if (times.error) throw new Error(`time_entries: ${times.error.message}`);

  type Row = {
    id: string;
    occurred_on: string;
    category_name: string | null;
    cause_code: string | null;
    description: string;
    status: string;
    stage_id: string | null;
    stage_name: string | null;
    raised_at: string | null;
    photo_count: number | null;
    rework_entry_ids: string[] | null;
  };
  return {
    ready: true,
    categories: ((cats.data ?? []) as { id: string; name: string }[]).map((c) => ({ id: c.id, name: c.name })),
    stages: stages.map((s) => ({ id: s.id, name: s.name, completed: !!s.completedAt })),
    timeEntries: ((times.data ?? []) as { id: string; clock_in: string; clock_out: string | null; hours: number | null }[]).map((t) => ({
      id: t.id,
      clockIn: t.clock_in,
      clockOut: t.clock_out,
      hours: t.hours == null ? null : Number(t.hours),
    })),
    mistakes: ((mine.data ?? []) as Row[]).map((m) => ({
      id: m.id,
      occurredOn: m.occurred_on,
      category: m.category_name,
      causeCode: m.cause_code,
      description: m.description,
      status: m.status,
      stageId: m.stage_id,
      stageName: m.stage_name,
      raisedAt: m.raised_at,
      photoCount: Number(m.photo_count ?? 0),
      reworkEntryIds: (m.rework_entry_ids ?? []).filter((x): x is string => typeof x === "string"),
    })),
  };
}
