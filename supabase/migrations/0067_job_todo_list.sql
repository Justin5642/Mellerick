-- =============================================
-- JOB TO-DO LIST: JOBS OFFICE CAN PULL IN TO FILL A SCHEDULE GAP
-- STATUS: DRAFT — NOT APPLIED. Apply to production, then update this line.
--
-- Asked for by the owner: "add jobs to a to do list so that they can be
-- assigned when we have a hole to fill." Decisions already made:
--   * Office ADDS a job to the list by hand (web job page). Nothing is listed
--     automatically.
--   * A job LEAVES the list by itself once it is scheduled. That rule lives in
--     a trigger here, not in the web button, because jobs are scheduled from
--     the web dialog, the Schedule board drag, the mobile office screens (via
--     the outbox) and the Google Calendar poll (lib/google.ts). A rule in one
--     caller would leave stale entries from every other one.
--   * Each listed job carries ESTIMATED HOURS so office can match it to the
--     size of the gap. The UI falls back to the job's PO allocated hours
--     (purchase_orders.total_hours) when no estimate is set.
--
-- COLUMNS (all nullable, no default, no backfill — every existing job reads
-- "not on the list", which is the truth):
--   todo_listed_at  timestamptz  null = not on the list; otherwise on it since then
--   todo_listed_by  uuid         who put it there
-- On listing, the trigger stamps todo_listed_at with the database's now() and
-- todo_listed_by with auth.uid(); once listed, both are kept as they were.
--   estimated_hours numeric      0..1000. HOURS, not money — safe for any role.
--
-- WHEN THE TRIGGER TAKES A JOB OFF THE LIST (BEFORE INSERT OR UPDATE):
--   * scheduled_start is set to a value it did not hold before (first schedule
--     or a reschedule). Unscheduling (start -> null) does NOT re-list a job;
--     office re-adds it if they want it back.
--   * status is scheduled / in_progress / completed / cancelled. This is a
--     STATE check, not a transition check, so a job already in one of those
--     states cannot be put on the list at all — a write that tries comes back
--     with todo_listed_at still null, and the web reports that.
--   pending and on_hold jobs stay listable.
--
-- RLS: unchanged. jobs still carries the open baseline policy (0000:131), so
-- these columns are readable and writable by any signed-in user exactly like
-- every other jobs column. Nothing here is financial.
--
-- PowerSync: tech_jobs names its columns (sync-streams.yaml), so nothing new
-- reaches a technician device. office_jobs syncs jobs.*, so office devices
-- receive the three columns; mobile/lib/powersync/schema.ts declares them.
--
-- Idempotent (if not exists / create or replace / drop trigger if exists) and
-- asserts its end state. Proven on the CI stack by tests/rls/job-todo-list.test.ts.
-- =============================================

alter table jobs add column if not exists todo_listed_at timestamptz;
alter table jobs add column if not exists todo_listed_by uuid references profiles(id) on delete set null;
alter table jobs add column if not exists estimated_hours numeric;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.jobs'::regclass and conname = 'jobs_estimated_hours_range'
  ) then
    alter table jobs add constraint jobs_estimated_hours_range
      check (estimated_hours is null or (estimated_hours >= 0 and estimated_hours <= 1000));
  end if;
end $$;

comment on column jobs.todo_listed_at is
  'Office to-do list: null = not listed; otherwise listed since. Cleared by trigger jobs_todo_list_autoclear once the job is scheduled.';
comment on column jobs.todo_listed_by is
  'Office to-do list: who listed the job. Set to auth.uid() by trigger on listing.';
comment on column jobs.estimated_hours is
  'Office estimate of hours to complete, used to fit to-do jobs into schedule gaps. Hours only, never money.';

-- The Schedule page's to-do panel reads only listed jobs; most jobs never are.
create index if not exists jobs_todo_listed_at_idx on jobs (todo_listed_at) where todo_listed_at is not null;

create or replace function jobs_todo_list_autoclear()
returns trigger
language plpgsql
as $$
begin
  if new.todo_listed_at is not null then
    if new.status in ('scheduled', 'in_progress', 'completed', 'cancelled')
       or (new.scheduled_start is not null
           and (tg_op = 'INSERT' or new.scheduled_start is distinct from old.scheduled_start)) then
      new.todo_listed_at := null;
    end if;
  end if;

  if new.todo_listed_at is null then
    new.todo_listed_by := null;
  elsif tg_op = 'INSERT' or old.todo_listed_at is null then
    -- Newly listed: stamp the database clock, not the browser's (a slow or
    -- fast laptop would otherwise reorder the list), and record the caller
    -- rather than whatever the client sent. auth.uid() is null for the
    -- service role / SQL editor, so keep the supplied value then.
    new.todo_listed_at := now();
    new.todo_listed_by := coalesce(auth.uid(), new.todo_listed_by);
  else
    -- Already listed: the original listing time and lister stand.
    new.todo_listed_at := old.todo_listed_at;
    new.todo_listed_by := old.todo_listed_by;
  end if;

  return new;
end;
$$;

drop trigger if exists jobs_todo_list_autoclear on jobs;
create trigger jobs_todo_list_autoclear
  before insert or update on jobs
  for each row execute function jobs_todo_list_autoclear();

-- Post-condition: the three columns, the range check, the index and the
-- trigger all exist. A migration that reports success without them would leave
-- the web panel silently empty.
do $$
declare
  n int;
begin
  select count(*) into n from information_schema.columns
   where table_schema = 'public' and table_name = 'jobs'
     and column_name in ('todo_listed_at', 'todo_listed_by', 'estimated_hours');
  if n <> 3 then
    raise exception 'ASSERTION FAILED: expected 3 to-do columns on jobs after 0067, found %', n;
  end if;

  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.jobs'::regclass and conname = 'jobs_estimated_hours_range') then
    raise exception 'ASSERTION FAILED: jobs_estimated_hours_range check missing after 0067';
  end if;

  if not exists (select 1 from pg_indexes
                  where schemaname = 'public' and tablename = 'jobs' and indexname = 'jobs_todo_listed_at_idx') then
    raise exception 'ASSERTION FAILED: jobs_todo_listed_at_idx missing after 0067';
  end if;

  if not exists (select 1 from pg_trigger
                  where tgrelid = 'public.jobs'::regclass and tgname = 'jobs_todo_list_autoclear'
                    and not tgisinternal and tgenabled <> 'D') then
    raise exception 'ASSERTION FAILED: trigger jobs_todo_list_autoclear missing or disabled after 0067';
  end if;
end $$;
