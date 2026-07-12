-- =============================================
-- ALLOCATED HOURS OVERTIME TRACKING
-- Run this once in the Supabase SQL editor.
--
-- Purpose: when a technician exceeds a job's allocated labour hours
-- (purchase_orders.total_hours), the mobile app prompts them to log a
-- reason (unexpected issue, difficult site, training needed, other) so
-- office can track technician efficiency and training needs, per the
-- CRM spec item "Allocated Labour Hours and Countdown".
-- =============================================

alter table jobs add column if not exists overtime_reason text;
alter table jobs add column if not exists overtime_category text
  check (overtime_category in ('unexpected_issue', 'difficult_site', 'training_needed', 'other'));
alter table jobs add column if not exists overtime_logged_by uuid references profiles(id);
alter table jobs add column if not exists overtime_logged_at timestamptz;

comment on column jobs.overtime_reason is
  'Free-text reason a technician logged when they exceeded the job''s allocated labour hours (from the mobile Hours Scoreboard).';
comment on column jobs.overtime_category is
  'Category picked alongside overtime_reason: unexpected_issue | difficult_site | training_needed | other.';
