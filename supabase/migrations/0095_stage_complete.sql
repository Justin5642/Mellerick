-- ============================================================================
-- A job stage marked complete from site.
--
-- STATUS: ✅ APPLIED IN PRODUCTION (2026-11-04, via SQL editor). Gate test
-- supabase/tests/0095_stage_complete_test.sql passed.
--
-- WHY (Justin, 4 Nov 2026): multi-day jobs need a sign-off that isn't "job
-- complete". At the end of a day the crew "Finish for today" (a dated job note,
-- no schema change); when a stage of the builder's PO is done — Sewer, Hook
-- Up — they mark that stage complete, so the office can raise the progress
-- claim against that stage while the job stays open for the next.
--
--   po_cost_centers.completed_at   when the stage was marked done. Null = open.
--   po_cost_centers.completed_by   who marked it (crew on site, or the office).
--
-- Written only through /api/jobs/[id]/stages/[stageId]/complete (service role
-- after checking the caller is on the job, or office/admin): po_cost_centers
-- is office-only by RLS and technicians read it through po_cost_centers_public
-- (0038), which is unchanged.
-- ============================================================================

alter table po_cost_centers add column if not exists completed_at timestamptz;
alter table po_cost_centers add column if not exists completed_by uuid references profiles(id) on delete set null;

comment on column po_cost_centers.completed_at is
  'When this stage of the job was marked complete from site or by the office (0095). Null = still open.';
comment on column po_cost_centers.completed_by is
  'Who marked the stage complete (0095).';

notify pgrst, 'reload schema';
