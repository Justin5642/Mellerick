-- =============================================
-- TRACK ACTUAL SPEND/HOURS AGAINST PO COST CENTRES
-- Run this once in the Supabase SQL editor.
--
-- Purpose: `po_cost_centers` already lets a PO be broken into stages (e.g.
-- Excavation $5,000/20h, Reinstatement $2,000/8h) with a budgeted $ amount
-- and hours -- but nothing logged against a job (expenses, time entries)
-- was ever linked back to a specific stage, so there was no way to see
-- "$3,200 spent / 14h logged so far on Excavation" -- only the whole-job
-- total. This adds the missing link on both tables so actual-vs-allocated
-- can be tracked per stage, not just per job.
-- =============================================

alter table job_expenses
  add column if not exists cost_center_id uuid references po_cost_centers(id) on delete set null;

alter table time_entries
  add column if not exists cost_center_id uuid references po_cost_centers(id) on delete set null;

create index if not exists job_expenses_cost_center_id_idx on job_expenses(cost_center_id);
create index if not exists time_entries_cost_center_id_idx on time_entries(cost_center_id);

comment on column job_expenses.cost_center_id is
  'Which PO cost centre (job stage) this expense counts against. Null means logged against the job generally, not yet assigned to a stage.';

comment on column time_entries.cost_center_id is
  'Which PO cost centre (job stage) this time entry counts against. Null means not yet assigned to a stage (e.g. auto clock-in via geofencing, which has no one present to ask).';
