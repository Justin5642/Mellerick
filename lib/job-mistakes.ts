// Mistake costs on a job (Justin, 23 Nov 2026: "We also need a way of tracking
// the expense of mistakes in each cost centre that will be a negative cost").
// The office logs each one against one of the job's PO lines; it counts as
// cost in the Job Ledger (lib/job-ledger.ts), so it reduces the job's — and
// that cost centre's — margin, shown as its own "Mistakes" figure.
//
// Stored in job_mistakes, migration 0115 (DRAFT — not applied yet when this
// was written). Office/admin only by RLS for every operation, in no PowerSync
// stream: technicians never read a mistake or its amount. Until 0115 is
// applied every reader treats the missing table as "no mistakes" and the UI
// says it isn't switched on yet (isMissingMistakesTable).
//
// Pure apart from loadJobMistakes, which only builds a query.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";

export const MISTAKE_COLUMNS = "id, job_id, cost_center_id, occurred_on, amount_ex_gst, description, cause, staff_id, entered_by, created_at";

export interface JobMistake {
  id: string;
  job_id: string;
  cost_center_id: string | null;
  occurred_on: string;
  amount_ex_gst: number;
  description: string;
  cause: string | null;
  staff_id: string | null;
  entered_by: string | null;
  created_at: string;
}

export const DESCRIPTION_MAX = 2000;
export const CAUSE_MAX = 500;

/** Postgres / PostgREST "the table (or a column) isn't there yet" — before the draft 0115 is applied. */
export function isMissingMistakesTable(error: { code?: string | null } | null | undefined): boolean {
  return !!error && ["42P01", "PGRST205", "PGRST200", "42703", "PGRST204"].includes(error.code ?? "");
}

export interface MistakeForm {
  occurred_on: string;
  cost_center_id: string;
  amount: string;
  description: string;
  cause: string;
  staff_id: string;
}

export interface MistakeRow {
  occurred_on: string;
  cost_center_id: string | null;
  amount_ex_gst: number;
  description: string;
  cause: string | null;
  staff_id: string | null;
}

/**
 * The form → the row to write, or the first problem as a sentence.
 * `lineIds` are the job's PO lines: a cost centre must be one of them (the
 * database refuses another job's line too). "" = not tagged / nobody.
 */
export function buildMistakeRow(form: MistakeForm, lineIds: string[]): { ok: true; row: MistakeRow } | { ok: false; error: string } {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(form.occurred_on) || Number.isNaN(Date.parse(`${form.occurred_on}T00:00:00Z`))) {
    return { ok: false, error: "Enter the date of the mistake." };
  }
  const raw = form.amount.replace(/[$,\s]/g, "");
  const amount = Number(raw);
  if (!raw || !Number.isFinite(amount) || amount <= 0) {
    return { ok: false, error: "Enter what the mistake cost (ex GST), more than $0." };
  }
  if (amount >= 1e10) return { ok: false, error: "That amount is too large." };
  const description = form.description.trim();
  if (!description) return { ok: false, error: "Say what went wrong." };
  if (description.length > DESCRIPTION_MAX) return { ok: false, error: `Keep the description under ${DESCRIPTION_MAX} characters.` };
  const cause = form.cause.trim();
  if (cause.length > CAUSE_MAX) return { ok: false, error: `Keep the cause under ${CAUSE_MAX} characters.` };
  const centre = form.cost_center_id || null;
  if (centre && !lineIds.includes(centre)) return { ok: false, error: "Pick one of this job's cost centres." };
  return {
    ok: true,
    row: {
      occurred_on: form.occurred_on,
      cost_center_id: centre,
      amount_ex_gst: Math.round(amount * 100) / 100,
      description,
      cause: cause || null,
      staff_id: form.staff_id || null,
    },
  };
}

export function formFromMistake(m: JobMistake): MistakeForm {
  return {
    occurred_on: m.occurred_on,
    cost_center_id: m.cost_center_id ?? "",
    amount: String(Number(m.amount_ex_gst)),
    description: m.description,
    cause: m.cause ?? "",
    staff_id: m.staff_id ?? "",
  };
}

/** Newest first, then most recently entered. */
export function sortMistakes<T extends Pick<JobMistake, "occurred_on" | "created_at">>(list: T[]): T[] {
  return [...list].sort((a, b) => b.occurred_on.localeCompare(a.occurred_on) || b.created_at.localeCompare(a.created_at));
}

export function mistakesTotal(list: { amount_ex_gst: number | null }[]): number {
  return Math.round(list.reduce((s, m) => s + Number(m.amount_ex_gst ?? 0), 0) * 100) / 100;
}

/**
 * One job's mistakes. `ready: false` when the table isn't there yet (0115 is a
 * draft); an error is left to the caller (a fixed sentence, never the text).
 */
export async function loadJobMistakes(
  supabase: SupabaseClient<Database>,
  jobId: string
): Promise<{ ready: boolean; mistakes: JobMistake[]; error: string | null }> {
  const { data, error } = await supabase.from("job_mistakes").select(MISTAKE_COLUMNS).eq("job_id", jobId);
  if (error) {
    if (isMissingMistakesTable(error)) return { ready: false, mistakes: [], error: null };
    return { ready: true, mistakes: [], error: error.message };
  }
  const rows = ((data ?? []) as JobMistake[]).map((m) => ({ ...m, amount_ex_gst: Number(m.amount_ex_gst) }));
  return { ready: true, mistakes: sortMistakes(rows), error: null };
}
