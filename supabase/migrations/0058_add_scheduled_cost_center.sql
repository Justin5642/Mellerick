-- =============================================
-- SCHEDULE A JOB TO A COST CENTRE UP FRONT
--
-- Purpose: cost centres (po_cost_centers) are currently only assignable to a
-- time entry or expense after the fact, one row at a time. This lets the
-- office pick a cost centre when scheduling the job, so time entries can
-- default to it at clock-in instead of every technician having to pick a
-- stage themselves.
-- =============================================

alter table jobs
  add column if not exists scheduled_cost_center_id uuid references po_cost_centers(id) on delete set null;

create index if not exists jobs_scheduled_cost_center_id_idx on jobs(scheduled_cost_center_id);

comment on column jobs.scheduled_cost_center_id is
  'The PO cost centre (job stage) this job is scheduled against. New time_entries default their cost_center_id to this value at clock-in; null means the job has no stage pre-selected.';
