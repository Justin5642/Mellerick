-- =============================================
-- TRAVEL TIME TRACKING
-- Run this once in the Supabase SQL editor.
--
-- Purpose: implements CRM spec item "Travel Time Tracking" alongside
-- "Geofencing and Auto Clock In/Out". Adds a distinction between
-- on-site labour ('work') and drive time between jobs ('travel') on
-- the existing time_entries table, so travel time can be tracked and
-- reported without inflating the allocated-hours budget/countdown.
-- =============================================

alter table time_entries add column if not exists entry_type text not null default 'work'
  check (entry_type in ('work', 'travel'));

alter table time_entries add column if not exists travel_from_job_id uuid references jobs(id);

comment on column time_entries.entry_type is
  'work = on-site labour, counted against a job''s allocated hours budget. travel = time spent driving between jobs, tracked for reporting but NOT counted against allocated hours.';
comment on column time_entries.travel_from_job_id is
  'For entry_type=travel rows only: the job the tech was traveling FROM. The row''s own job_id is the destination job. Null = traveled from home/start of day (no prior job today).';
