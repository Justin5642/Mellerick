-- ============================================================================
-- Multi-day schedules: a job booked for the same hours on several workdays.
--
-- STATUS: ✅ APPLIED IN PRODUCTION (2026-10-14, via SQL editor), before the
-- code that writes these columns was merged; PowerSync sync rules (tech_jobs
-- lists both columns explicitly) redeployed the same day. Verify, do not trust
-- this comment:
--   select column_name from information_schema.columns
--   where table_name = 'jobs' and column_name like 'schedule_%';
--
-- WHY
-- A job holds one window, scheduled_start..scheduled_end. Booking a technician
-- Mon–Wed meant either three jobs or one 56-hour block that the board showed on
-- Monday only. The office wants "start date, end date, all day = 7:00–15:30 on
-- each of those days".
--
-- SHAPE
-- No per-day table. The existing window keeps its meaning for every job that
-- exists today (schedule_daily defaults false). When schedule_daily is true,
-- scheduled_start is the first day + daily start time and scheduled_end the
-- last day + daily end time, and the job occupies those hours on each booked
-- day — weekdays between the two dates, plus either date itself even when it is
-- a weekend. That rule lives in ONE place, lib/scheduling.ts (mirrored at
-- mobile/lib/scheduling.ts, pinned identical by
-- tests/unit/scheduling-multiday.test.ts); every reader asks it rather than
-- bucketing on scheduled_start.
--
-- A per-day table would have been one more PowerSync stream, one more child in
-- 0068's sync triggers, and a second source of truth for "when is this job"
-- next to scheduled_start, which the calendar sync, the to-do-list trigger
-- (0067) and the sync windows (0068) all already read. Two flags keep all of
-- those working unchanged.
--
-- schedule_all_day only remembers that "All day" was ticked so the dialog
-- reopens as saved; the times are the source of truth.
--
-- Safe to re-run. No policy, grant or trigger changes; jobs is already in the
-- powersync publication, and office_jobs syncs jobs.*.
-- ============================================================================

alter table jobs
  add column if not exists schedule_daily boolean not null default false,
  add column if not exists schedule_all_day boolean not null default false;

comment on column jobs.schedule_daily is
  'When true, scheduled_start..scheduled_end means the same daily hours on each booked day (weekdays between the dates, plus either endpoint). See lib/scheduling.ts scheduleDays().';
comment on column jobs.schedule_all_day is
  'The "All day" box was ticked when scheduling (7:00–15:30 each day). Display only; the times are authoritative.';

do $$
begin
  if not exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'jobs' and column_name = 'schedule_daily')
     or not exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'jobs' and column_name = 'schedule_all_day') then
    raise exception 'ASSERTION FAILED: jobs.schedule_daily / schedule_all_day missing after 0071';
  end if;
end;
$$;
