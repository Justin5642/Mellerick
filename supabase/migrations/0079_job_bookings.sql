-- ============================================================================
-- Job bookings: each technician's own time and cost centre on a job.
--
-- STATUS: ✅ APPLIED IN PRODUCTION (2026-10-19, via db query --linked). Gate test
-- passed; conversion verified: 15 scheduled jobs → 17 bookings (4 unassigned),
-- none missing, no pushes. First attempt aborted cleanly on job #2520's
-- inverted window; the window check was removed (#89) and it re-ran.
--
-- WHY
-- A job had ONE schedule (jobs.scheduled_start/end, schedule_daily/all_day,
-- scheduled_cost_center_id) shared by its whole crew. Jobs are worked in pairs
-- and stages: Dave on rough-in Mon–Tue, Sam rough-in Monday morning only, Dave
-- back for fit-off Thursday. Agreed with Justin 19 Oct 2026: any number of
-- bookings per job, any number per technician, each with its own cost centre
-- and window; one calendar event per booking (stage 2).
--
-- THE MODEL
-- job_bookings is the source of truth. The job-level columns become DERIVED
-- from it, so the many screens that only need "who and roughly when" keep
-- working unchanged:
--   jobs.scheduled_start / scheduled_end  earliest start / latest end
--   jobs.schedule_daily / schedule_all_day  set only when every booking shares
--                                          one window (the old single-schedule
--                                          case); otherwise false
--   jobs.scheduled_cost_center_id          set only when every booking agrees
--   job_assignments (the crew)             includes every booked technician;
--                                          a technician whose last booking is
--                                          removed leaves the crew
-- A booking may have no technician (staff_id null): the board's Unassigned
-- column, as a scheduled job with no crew is today.
--
-- COMPATIBILITY WITH SCREENS THAT STILL WRITE THE OLD WAY
-- Mobile builds ≤15 and today's web board write the job-level schedule and the
-- crew. Those writes are translated, keeping their old meaning ("the crew
-- shares the job's window"):
--   * a client write to the job's schedule columns REPLACES its bookings with
--     one per crew member (one unassigned booking if there is no crew) on the
--     new window;
--   * a client adding someone to the crew of a job whose bookings all share one
--     window gives them that window too; removing someone from the crew
--     removes their bookings.
-- Writes made BY these triggers set the transaction-local flag
-- app.booking_sync = 'on' so they are never translated back (no loops), and
-- restore it afterwards.
--
-- PUSH: a booking for a technician new to the job adds them to the crew, which
-- fires the "New job assigned" push (0077) exactly as before.
-- ============================================================================

create table if not exists job_bookings (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references jobs(id) on delete cascade,
  staff_id uuid references profiles(id) on delete set null,
  cost_center_id uuid references po_cost_centers(id) on delete set null,
  starts_at timestamptz not null,
  ends_at timestamptz,
  daily boolean not null default false,
  all_day boolean not null default false,
  google_event_id text,
  created_by uuid default auth.uid() references profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
  -- NO check that ends_at >= starts_at, on purpose. jobs never had one, and
  -- production already holds a job (#2520) whose end is before its start. A
  -- check here aborted this migration's conversion on that row, and would also
  -- make every old-style client write that carries such a window fail with a
  -- database error (the translation trigger inserts bookings inside the
  -- client's own statement). The booking editors validate new windows instead.
);

create index if not exists job_bookings_job_idx on job_bookings (job_id, starts_at);
create index if not exists job_bookings_staff_idx on job_bookings (staff_id, starts_at);

comment on table job_bookings is
  'One technician''s time and cost centre on a job (0079). Source of truth for scheduling; '
  'jobs.scheduled_* and job_assignments are derived from it. staff_id null = unassigned.';

alter table job_bookings enable row level security;

-- Readable by every signed-in user, like jobs and job_assignments' crew view on
-- the board. Written by office/admin only.
drop policy if exists "job bookings are readable by staff" on job_bookings;
create policy "job bookings are readable by staff" on job_bookings for select to authenticated
  using (true);
drop policy if exists "job bookings are writable by office/admin" on job_bookings;
create policy "job bookings are writable by office/admin" on job_bookings for insert to authenticated
  with check ((select is_office_or_admin(auth.uid())));
drop policy if exists "job bookings are updatable by office/admin" on job_bookings;
create policy "job bookings are updatable by office/admin" on job_bookings for update to authenticated
  using ((select is_office_or_admin(auth.uid()))) with check ((select is_office_or_admin(auth.uid())));
drop policy if exists "job bookings are deletable by office/admin" on job_bookings;
create policy "job bookings are deletable by office/admin" on job_bookings for delete to authenticated
  using ((select is_office_or_admin(auth.uid())));

revoke all on job_bookings from anon;

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

-- Run `body` with app.booking_sync on, restoring the previous value after.
-- Used by every trigger here so their own writes are not translated back.
create or replace function booking_sync_active()
returns boolean
language sql
stable
as $$
  select coalesce(current_setting('app.booking_sync', true), '') = 'on';
$$;

-- Recompute a job's derived schedule columns and crew from its bookings.
create or replace function refresh_job_from_bookings(p_job_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  prev text := coalesce(current_setting('app.booking_sync', true), '');
  n int;
  n_windows int;
  n_cc int;
  v_start timestamptz;
  v_end timestamptz;
  v_any_open_end boolean;
  v_daily boolean;
  v_all_day boolean;
  v_cc uuid;
begin
  perform set_config('app.booking_sync', 'on', true);

  select count(*),
         count(distinct (starts_at, ends_at, daily, all_day)),
         count(distinct coalesce(cost_center_id::text, '-')),
         min(starts_at),
         max(coalesce(ends_at, starts_at)),
         bool_or(ends_at is null),
         bool_and(daily),
         bool_and(all_day),
         min(cost_center_id::text)::uuid
    into n, n_windows, n_cc, v_start, v_end, v_any_open_end, v_daily, v_all_day, v_cc
    from job_bookings where job_id = p_job_id;

  if n = 0 then
    update jobs
       set scheduled_start = null, scheduled_end = null,
           schedule_daily = false, schedule_all_day = false,
           scheduled_cost_center_id = null
     where id = p_job_id
       and (scheduled_start is not null or scheduled_end is not null);
  else
    update jobs
       set scheduled_start = v_start,
           -- A single start-only booking keeps the job start-only.
           scheduled_end = case when n_windows = 1 and v_any_open_end then null else v_end end,
           schedule_daily = (n_windows = 1 and v_daily),
           schedule_all_day = (n_windows = 1 and v_all_day),
           scheduled_cost_center_id = case when n_cc = 1 then v_cc else null end
     where id = p_job_id;

    -- Every booked technician is on the crew.
    insert into job_assignments (job_id, staff_id, assigned_by)
    select distinct p_job_id, b.staff_id, auth.uid()
      from job_bookings b
     where b.job_id = p_job_id and b.staff_id is not null
    on conflict (job_id, staff_id) do nothing;
  end if;

  perform set_config('app.booking_sync', prev, true);
end;
$$;

-- ---------------------------------------------------------------------------
-- 1. Bookings change → derive the job
-- ---------------------------------------------------------------------------
create or replace function job_bookings_after_change()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  prev text := coalesce(current_setting('app.booking_sync', true), '');
begin
  if tg_op in ('UPDATE', 'DELETE') then
    -- A technician whose last booking on the job went leaves the crew. Only
    -- for a real booking edit, not while a translation is rebuilding them.
    if not booking_sync_active()
       and old.staff_id is not null
       and (tg_op = 'DELETE' or new.staff_id is distinct from old.staff_id or new.job_id <> old.job_id)
       and not exists (select 1 from job_bookings
                        where job_id = old.job_id and staff_id = old.staff_id) then
      perform set_config('app.booking_sync', 'on', true);
      delete from job_assignments where job_id = old.job_id and staff_id = old.staff_id;
      perform set_config('app.booking_sync', prev, true);
    end if;
    perform refresh_job_from_bookings(old.job_id);
  end if;
  if tg_op in ('INSERT', 'UPDATE') then
    if tg_op = 'INSERT' or new.job_id <> old.job_id then
      perform refresh_job_from_bookings(new.job_id);
    elsif new is distinct from old then
      perform refresh_job_from_bookings(new.job_id);
    end if;
  end if;
  return null;
end;
$$;

create or replace function job_bookings_touch()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists job_bookings_touch on job_bookings;
create trigger job_bookings_touch before update on job_bookings
  for each row execute function job_bookings_touch();

drop trigger if exists job_bookings_derive on job_bookings;
create trigger job_bookings_derive after insert or update or delete on job_bookings
  for each row execute function job_bookings_after_change();

-- ---------------------------------------------------------------------------
-- 2. Old-style job schedule write → rebuild bookings (shared window)
-- ---------------------------------------------------------------------------
create or replace function jobs_schedule_to_bookings()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  prev text := coalesce(current_setting('app.booking_sync', true), '');
begin
  if booking_sync_active() then
    return null;
  end if;
  if tg_op = 'UPDATE'
     and new.scheduled_start is not distinct from old.scheduled_start
     and new.scheduled_end is not distinct from old.scheduled_end
     and new.schedule_daily is not distinct from old.schedule_daily
     and new.schedule_all_day is not distinct from old.schedule_all_day
     and new.scheduled_cost_center_id is not distinct from old.scheduled_cost_center_id then
    return null;
  end if;
  if tg_op = 'INSERT' and new.scheduled_start is null then
    return null;
  end if;

  perform set_config('app.booking_sync', 'on', true);
  delete from job_bookings where job_id = new.id;
  if new.scheduled_start is not null then
    insert into job_bookings (job_id, staff_id, cost_center_id, starts_at, ends_at, daily, all_day, created_by)
    select new.id, crew.staff_id, new.scheduled_cost_center_id, new.scheduled_start, new.scheduled_end,
           new.schedule_daily, new.schedule_all_day, auth.uid()
      from (select staff_id from job_assignments where job_id = new.id
            union all
            select null::uuid where not exists (select 1 from job_assignments where job_id = new.id)) crew;
  end if;
  perform set_config('app.booking_sync', prev, true);
  return null;
end;
$$;

drop trigger if exists jobs_schedule_to_bookings on jobs;
create trigger jobs_schedule_to_bookings
  after insert or update of scheduled_start, scheduled_end, schedule_daily, schedule_all_day, scheduled_cost_center_id
  on jobs
  for each row execute function jobs_schedule_to_bookings();

-- ---------------------------------------------------------------------------
-- 3. Old-style crew change → keep bookings in step
-- ---------------------------------------------------------------------------
create or replace function job_assignments_to_bookings()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  prev text := coalesce(current_setting('app.booking_sync', true), '');
  n_windows int;
  b record;
begin
  if booking_sync_active() then
    return null;
  end if;
  perform set_config('app.booking_sync', 'on', true);

  if tg_op = 'DELETE' then
    delete from job_bookings where job_id = old.job_id and staff_id = old.staff_id;
    perform refresh_job_from_bookings(old.job_id);
  elsif tg_op = 'INSERT'
        and not exists (select 1 from job_bookings where job_id = new.job_id and staff_id = new.staff_id) then
    select count(distinct (starts_at, ends_at, daily, all_day, cost_center_id)) into n_windows
      from job_bookings where job_id = new.job_id;
    if n_windows = 1 then
      -- The old meaning: the crew shares the job's one window. An unassigned
      -- booking on that window is taken over rather than duplicated.
      select * into b from job_bookings where job_id = new.job_id order by starts_at limit 1;
      if exists (select 1 from job_bookings where job_id = new.job_id and staff_id is null) then
        update job_bookings set staff_id = new.staff_id
         where id = (select id from job_bookings where job_id = new.job_id and staff_id is null limit 1);
      else
        insert into job_bookings (job_id, staff_id, cost_center_id, starts_at, ends_at, daily, all_day, created_by)
        values (new.job_id, new.staff_id, b.cost_center_id, b.starts_at, b.ends_at, b.daily, b.all_day, auth.uid());
      end if;
    end if;
    -- Several different windows: they join the crew without a booking; the
    -- office books them from the job's Schedule dialog.
  end if;

  perform set_config('app.booking_sync', prev, true);
  return null;
end;
$$;

drop trigger if exists job_assignments_to_bookings on job_assignments;
create trigger job_assignments_to_bookings
  after insert or delete on job_assignments
  for each row execute function job_assignments_to_bookings();

revoke execute on function refresh_job_from_bookings(uuid) from public, anon, authenticated;
revoke execute on function job_bookings_after_change() from public, anon, authenticated;
revoke execute on function jobs_schedule_to_bookings() from public, anon, authenticated;
revoke execute on function job_assignments_to_bookings() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. Convert today's schedules: one booking per crew member (or one
--    unassigned booking) on the job's current window. Done with the sync flag
--    on so it neither notifies anyone nor rewrites the jobs it reads from.
-- ---------------------------------------------------------------------------
do $$
begin
  perform set_config('app.booking_sync', 'on', true);
  insert into job_bookings (job_id, staff_id, cost_center_id, starts_at, ends_at, daily, all_day, created_by, created_at)
  select j.id, crew.staff_id, j.scheduled_cost_center_id, j.scheduled_start, j.scheduled_end,
         j.schedule_daily, j.schedule_all_day, null, now()
    from jobs j
    cross join lateral (
      select a.staff_id from job_assignments a where a.job_id = j.id
      union all
      select null::uuid where not exists (select 1 from job_assignments a where a.job_id = j.id)
    ) crew
   where j.scheduled_start is not null
     and not exists (select 1 from job_bookings x where x.job_id = j.id);
  perform set_config('app.booking_sync', '', true);
end;
$$;

-- ---------------------------------------------------------------------------
-- Assert
-- ---------------------------------------------------------------------------
do $$
declare
  missing int;
begin
  select count(*) into missing from jobs j
   where j.scheduled_start is not null
     and not exists (select 1 from job_bookings b where b.job_id = j.id);
  if missing > 0 then
    raise exception 'ASSERTION FAILED: % scheduled job(s) have no booking after conversion', missing;
  end if;
  if has_table_privilege('anon', 'public.job_bookings', 'select') then
    raise exception 'ASSERTION FAILED: anon can read job_bookings';
  end if;
end;
$$;
