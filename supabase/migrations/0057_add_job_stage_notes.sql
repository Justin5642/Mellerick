-- =============================================
-- STAGE-BASED JOB NOTES
--
-- Purpose: technicians log notes against a specific workflow stage (e.g. the
-- drain stage), so the next person to attend that job can pull up exactly
-- what happened at that stage instead of scrolling one shared note feed.
-- Sits alongside the existing flat `job_notes` table (left as-is/unstaged —
-- older history stays visible in the general notes feed) rather than
-- replacing it.
--
-- `stage` is a fixed, code-defined list (mirrored in lib/job-stages.ts and
-- mobile/lib/job-stages.ts) rather than an editable table like
-- cost_center_templates: those are PO billing line items, these are workflow
-- checkpoints every job moves through, so a fixed check constraint keeps
-- both platforms and the database in agreement without an extra settings UI.
-- =============================================

create table job_stage_notes (
  id uuid default uuid_generate_v4() primary key,
  job_id uuid references jobs(id) on delete cascade not null,
  stage text not null
    check (stage in ('quote', 'drain', 'rough_in', 'fit_off', 'test', 'invoice')),
  author_id uuid references profiles(id),
  content text not null,
  created_at timestamptz default now()
);

-- Composite so both "this job's whole history" and "just the drain stage's
-- history" (the leftmost-prefix job_id-only case is covered too) hit an
-- index, ordered newest-first to match how the notes feed renders.
create index job_stage_notes_job_id_stage_created_at_idx on job_stage_notes (job_id, stage, created_at desc);

alter table job_stage_notes enable row level security;
create policy "Authenticated users can manage job stage notes" on job_stage_notes for all using (auth.role() = 'authenticated');

comment on table job_stage_notes is
  'Notes logged against a specific workflow stage of a job (e.g. drain, rough_in) rather than one shared field, so history builds up stage by stage and the next technician on a job can pull up what happened at a given stage. Visible to everyone assigned to the job (app-level, same as job_notes -- RLS here is the same broad authenticated-role pattern used across job sub-tables). Distinct from job_notes, which is left as the general/unstaged notes feed.';

-- Keep the scoped PowerSync publication in sync (see migration 0039) -- a
-- table missing here silently never replicates to any device.
alter publication powersync add table job_stage_notes;
