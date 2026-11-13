-- ============================================================================
-- Completed and cancelled jobs cannot be scheduled.
--
-- STATUS: DRAFT — NOT APPLIED. Written 13 Nov 2026; apply in the SQL editor,
-- then run supabase/tests/0096_refuse_scheduling_closed_jobs_test.sql. The
-- web and phone already refuse in their own UI and read this refusal when it
-- arrives, so merging before applying changes nothing in the database.
--
-- WHY (bug report, Nov 2026): the office could "schedule" a job that was
-- already completed. The save landed and the app said so, but the schedule
-- board (web /dashboard/schedule and the phone's Schedule tab) lists only
-- jobs that are not completed or cancelled, so the booking never appeared
-- anywhere. Nothing told anyone why. Cancelled jobs are treated the same way:
-- the board hides them too, and the calendar sync removes their events.
--
-- WHAT IT REFUSES — with SQLSTATE MJ001 and a plain sentence, which PostgREST
-- returns as HTTP 400 and the apps show as-is:
--   * a NEW booking (job_bookings insert) on a completed/cancelled job;
--   * a booking moved (starts_at / ends_at / daily / all_day / job_id) or
--     given to someone (staff_id set to a person) on such a job;
--   * an old-style write of the job's own window (scheduled_start /
--     scheduled_end / schedule_daily / schedule_all_day) that leaves a
--     completed/cancelled job with a schedule — mobile builds ≤15, the
--     calendar poll's write-back, a queued outbox write replayed after the
--     job was signed off.
--
-- WHAT IT DELIBERATELY LETS THROUGH
--   * completing a scheduled job (a status-only write: no schedule column
--     changes, so the jobs trigger never refuses it);
--   * deleting bookings, unassigning one (staff_id → null, which is also what
--     a deleted profile's ON DELETE SET NULL does), changing its cost centre
--     or google_event_id, and clearing a job's schedule — none of these book
--     anyone;
--   * flag-only writes: the nightly sync_window_refresh() and the 0080 cascade
--     only set sync_office / sync_tech, which are not in either trigger's
--     column list, so neither trigger fires;
--   * 0079's own derived writes (app.booking_sync = 'on'): rebuilding a job's
--     bookings from an old-style write, re-deriving the job's window after a
--     booking is deleted, and a crew change on a job whose bookings share one
--     window. The client write that started them is checked; their echoes are
--     not — refusing an echo would make "delete a booking of a completed job"
--     fail when the job's window is re-derived.
--   * reopening: a write that sets the status back to open AND the schedule in
--     the same statement checks the NEW status, so it passes.
-- ============================================================================

do $$
begin
  if to_regclass('public.job_bookings') is null then
    raise exception '0096 needs 0079 (job_bookings) applied first';
  end if;
end;
$$;

-- The statuses that leave the schedule board. One place, so the two triggers
-- and the assertions below cannot disagree.
create or replace function job_status_is_closed(p_status text)
returns boolean
language sql
immutable
as $$
  select coalesce(p_status, '') in ('completed', 'cancelled');
$$;

-- ---------------------------------------------------------------------------
-- 1. Bookings
-- ---------------------------------------------------------------------------
create or replace function job_bookings_refuse_closed_job()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_status text;
  v_number int;
begin
  -- 0079's derived writes (see header).
  if booking_sync_active() then
    return new;
  end if;
  if tg_op = 'UPDATE'
     and new.job_id = old.job_id
     and new.starts_at is not distinct from old.starts_at
     and new.ends_at is not distinct from old.ends_at
     and new.daily is not distinct from old.daily
     and new.all_day is not distinct from old.all_day
     and (new.staff_id is null or new.staff_id is not distinct from old.staff_id) then
    return new;
  end if;

  select status, job_number into v_status, v_number from jobs where id = new.job_id;
  if job_status_is_closed(v_status) then
    raise exception 'Job #% is %. A % job can''t be scheduled — reopen it first.', v_number, v_status, v_status
      using errcode = 'MJ001',
            hint = 'Change the job''s status back to an open one, then schedule it.';
  end if;
  return new;
end;
$$;

drop trigger if exists job_bookings_refuse_closed_job on job_bookings;
create trigger job_bookings_refuse_closed_job
  before insert or update of job_id, staff_id, starts_at, ends_at, daily, all_day on job_bookings
  for each row execute function job_bookings_refuse_closed_job();

-- ---------------------------------------------------------------------------
-- 2. The job's own window (old-style writers)
-- ---------------------------------------------------------------------------
create or replace function jobs_refuse_scheduling_closed()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if booking_sync_active() then
    return new;
  end if;
  if not job_status_is_closed(new.status) then
    return new;
  end if;
  -- Clearing the schedule books nobody.
  if new.scheduled_start is null then
    return new;
  end if;
  if new.scheduled_start is not distinct from old.scheduled_start
     and new.scheduled_end is not distinct from old.scheduled_end
     and new.schedule_daily is not distinct from old.schedule_daily
     and new.schedule_all_day is not distinct from old.schedule_all_day then
    return new;
  end if;
  raise exception 'Job #% is %. A % job can''t be scheduled — reopen it first.', new.job_number, new.status, new.status
    using errcode = 'MJ001',
          hint = 'Change the job''s status back to an open one, then schedule it.';
end;
$$;

drop trigger if exists jobs_refuse_scheduling_closed on jobs;
create trigger jobs_refuse_scheduling_closed
  before update of scheduled_start, scheduled_end, schedule_daily, schedule_all_day on jobs
  for each row execute function jobs_refuse_scheduling_closed();

revoke execute on function job_bookings_refuse_closed_job() from public, anon, authenticated;
revoke execute on function jobs_refuse_scheduling_closed() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Assert (end state, found by enumeration — not by trusting the statements
-- above to have done what they say).
-- ---------------------------------------------------------------------------
do $$
declare
  n int;
begin
  select count(*) into n from pg_trigger
   where tgrelid = 'job_bookings'::regclass and not tgisinternal
     and tgname = 'job_bookings_refuse_closed_job' and tgenabled <> 'D';
  if n <> 1 then
    raise exception 'ASSERTION FAILED: job_bookings_refuse_closed_job trigger missing or disabled';
  end if;

  select count(*) into n from pg_trigger
   where tgrelid = 'jobs'::regclass and not tgisinternal
     and tgname = 'jobs_refuse_scheduling_closed' and tgenabled <> 'D';
  if n <> 1 then
    raise exception 'ASSERTION FAILED: jobs_refuse_scheduling_closed trigger missing or disabled';
  end if;

  -- Neither trigger may fire on a flag-only write (sync_window_refresh, the
  -- 0080 cascade): their column lists must not include the window flags.
  select count(*) into n
    from pg_trigger t
    join pg_attribute a on a.attrelid = t.tgrelid and a.attnum = any (t.tgattr::int2[])
   where t.tgname in ('job_bookings_refuse_closed_job', 'jobs_refuse_scheduling_closed')
     and a.attname in ('sync_office', 'sync_tech', 'updated_at', 'google_event_id', 'status');
  if n > 0 then
    raise exception 'ASSERTION FAILED: a 0096 trigger fires on a flag/bookkeeping column';
  end if;

  if not job_status_is_closed('completed') or not job_status_is_closed('cancelled')
     or job_status_is_closed('scheduled') or job_status_is_closed(null) then
    raise exception 'ASSERTION FAILED: job_status_is_closed() is wrong';
  end if;
end;
$$;
