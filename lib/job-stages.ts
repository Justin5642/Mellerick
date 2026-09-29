// Fixed workflow-stage list for stage-based job notes. Kept in one place so
// the web app, the mobile app, and the job_stage_notes check constraint
// (supabase/migrations/0057_add_job_stage_notes.sql) all agree on the same
// values and labels. Mirrored by hand at mobile/lib/job-stages.ts (same
// convention as lib/backflow.ts / mobile/lib/backflow.ts) -- there is no
// shared package between the two apps.
//
// Fixed rather than office-editable (unlike cost_center_templates, which is
// a PO billing line-item list): these are workflow checkpoints every job
// moves through, not a per-job configurable set.

export interface JobStage {
  value: string;
  label: string;
}

export const JOB_STAGES: JobStage[] = [
  { value: "quote", label: "Quote" },
  { value: "drain", label: "Drain" },
  { value: "rough_in", label: "Rough In" },
  { value: "fit_off", label: "Fit Off" },
  { value: "test", label: "Test" },
  { value: "invoice", label: "Invoice" },
];

export function getJobStageLabel(value: string): string {
  return JOB_STAGES.find((s) => s.value === value)?.label ?? value;
}

// Any shape that carries at least a stage + timestamp -- deliberately loose so
// callers can pass full job_stage_notes rows (possibly with a joined
// `profiles`/author) without this file needing to know that shape.
export interface StageNoteLike {
  stage: string;
  created_at: string;
}

// Derives "where the job currently is" from a list of stage notes in any
// order: the note with the most recent created_at, i.e. the last stage anyone
// logged activity against. This is intentionally NOT the same as jobs.status
// (whole-job lifecycle: pending/scheduled/in_progress/completed/...) or
// jobs.admin_status (office approval state) -- it answers "which of the 6
// workflow stages did the last person work on", so the next tech to open the
// job (or office staff scanning the jobs list) can see where the previous
// person left off without reading the full note history. Returns null when
// there are no notes yet (job hasn't had any stage note logged).
export function getCurrentStageNote<T extends StageNoteLike>(notes: T[]): T | null {
  if (notes.length === 0) return null;
  return notes.reduce((latest, note) => (note.created_at > latest.created_at ? note : latest));
}
