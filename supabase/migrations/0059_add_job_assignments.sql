-- =============================================
-- MULTI-TECHNICIAN JOB ASSIGNMENT
--
-- jobs.assigned_to has always held exactly one technician, but some jobs are
-- worked by a crew. The office needs to schedule a job to several technicians
-- at once, not one job per technician -- duplicating the job would fragment
-- time_entries, job_items, job_expenses and purchase_orders across multiple
-- job rows and risk double-counting or splitting invoicing for shared costs.
-- time_entries already carries job_id and staff_id independently, so a crew
-- logging time against one job already costs correctly today; the gap is
-- purely in the assignment/scheduling layer.
--
-- job_assignments is the new source of truth for "who is on this job". We are
-- deliberately NOT dropping jobs.assigned_to. The write surface for it is
-- large (job creation forms, the schedule wizard, the drag-and-drop board,
-- three mobile screens, CI fixtures) and mobile is offline-first with a
-- durable write-behind outbox: a stale app build can enqueue a direct
-- `assigned_to` write and replay it days later, long after this migration
-- ships. Two triggers below keep the column and the table in sync in both
-- directions, so every reader that still keys off assigned_to (most of the
-- codebase, today) keeps working the instant this table exists, which is
-- what lets the rollout be staged instead of one atomic cutover. Drop
-- assigned_to in a later migration once every reader has moved to
-- job_assignments and enough time has passed that no stale outbox entry can
-- still reference it directly.
--
-- Same "one rule, three places" shape as 0049: this migration updates the
-- database half (user_can_manage_job, both triggers). lib/api/job-authz.ts
-- and mobile/powersync/sync-streams.yaml are updated alongside it. If you
-- change this rule, change the other two.
-- =============================================

create table job_assignments (
  id uuid default uuid_generate_v4() primary key,
  job_id uuid references jobs(id) on delete cascade not null,
  staff_id uuid references profiles(id) not null,
  -- Who made the assignment. Null for rows the backfill below creates, since
  -- there is no "who" for history that predates this table.
  assigned_by uuid references profiles(id),
  created_at timestamptz default now(),
  unique (job_id, staff_id)
);

create index job_assignments_job_id_idx on job_assignments (job_id);
create index job_assignments_staff_id_idx on job_assignments (staff_id);

comment on table job_assignments is
  'Every technician currently assigned to a job. jobs.assigned_to is kept as a '
  'trigger-derived "primary assignee" (the earliest-added current row) for '
  'readers that have not migrated to this table yet -- see the two triggers '
  'below. Office/admin only may write here; a technician may read only the '
  'jobs they are on.';

alter table job_assignments enable row level security;

create policy "job assignments are readable by office/admin or the assignee"
  on job_assignments for select to authenticated
  using ((select is_office_or_admin(auth.uid())) or staff_id = auth.uid());

create policy "job assignments are writable only by office/admin" on job_assignments
  for insert to authenticated with check ((select is_office_or_admin(auth.uid())));

create policy "job assignments are updatable only by office/admin" on job_assignments
  for update to authenticated using ((select is_office_or_admin(auth.uid())))
  with check ((select is_office_or_admin(auth.uid())));

create policy "job assignments are deletable only by office/admin" on job_assignments
  for delete to authenticated using ((select is_office_or_admin(auth.uid())));

-- Backfill BEFORE the triggers below exist, so this one-time copy does not
-- churn them (and does not need an assigned_by -- there is no "who" for it).
insert into job_assignments (job_id, staff_id)
select id, assigned_to from jobs where assigned_to is not null
on conflict (job_id, staff_id) do nothing;

-- ---------------------------------------------------------------------------
-- job_assignments -> jobs.assigned_to. "Primary" = earliest-added current
-- assignee, so a job that goes from one technician to a crew keeps showing
-- the original technician to anything still reading assigned_to alone.
-- ---------------------------------------------------------------------------
create or replace function sync_job_primary_assignee()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  affected_job uuid := coalesce(new.job_id, old.job_id);
  primary_staff uuid;
begin
  select staff_id into primary_staff
  from job_assignments
  where job_id = affected_job
  order by created_at asc, staff_id asc
  limit 1;

  update jobs set assigned_to = primary_staff
  where id = affected_job and assigned_to is distinct from primary_staff;

  return null; -- AFTER trigger; return value is ignored.
end;
$$;

comment on function sync_job_primary_assignee() is
  'Recomputes jobs.assigned_to from job_assignments after any change to the '
  'latter. Pairs with collapse_job_assignments_on_direct_write below, which '
  'runs the sync in reverse -- see that function''s comment for why the pair '
  'does not loop.';

drop trigger if exists job_assignments_sync_primary on job_assignments;
create trigger job_assignments_sync_primary
  after insert or update or delete on job_assignments
  for each row execute function sync_job_primary_assignee();

-- ---------------------------------------------------------------------------
-- jobs.assigned_to (direct write) -> job_assignments. Any caller that still
-- writes the column directly -- an unmigrated app build, a create-job form,
-- CI's fixture seed -- gets the behavior it already expects: "I assigned it
-- to one technician" collapses job_assignments down to that one row.
--
-- Guarded by pg_trigger_depth() > 1 so this does not ping-pong with
-- sync_job_primary_assignee above:
--   * A direct `update jobs set assigned_to = x` fires this trigger at depth
--     1. It collapses job_assignments to {x}, whose own AFTER trigger fires
--     sync_job_primary_assignee at depth 2; that recomputes primary = x,
--     which is already the value in place, so its `is distinct from` guard
--     makes the update touch zero rows and nothing fires again.
--   * An insert/update/delete on job_assignments fires sync_job_primary_assignee
--     at depth 1, which issues `update jobs set assigned_to = ...`. That
--     update fires this trigger at depth 2, where the guard below no-ops it.
-- Both directions terminate after one hop.
-- ---------------------------------------------------------------------------
create or replace function collapse_job_assignments_on_direct_write()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if pg_trigger_depth() > 1 then
    return new;
  end if;

  if tg_op = 'UPDATE' and new.assigned_to is not distinct from old.assigned_to then
    return new;
  end if;

  delete from job_assignments where job_id = new.id;
  if new.assigned_to is not null then
    insert into job_assignments (job_id, staff_id, assigned_by)
    values (new.id, new.assigned_to, auth.uid())
    on conflict (job_id, staff_id) do nothing;
  end if;

  return new;
end;
$$;

drop trigger if exists jobs_collapse_assignments on jobs;
create trigger jobs_collapse_assignments
  after insert or update on jobs
  for each row execute function collapse_job_assignments_on_direct_write();

-- ---------------------------------------------------------------------------
-- user_can_manage_job -- now true for ANY current assignee, not just the
-- primary. Signature unchanged (still text, for the split_part(name, '/', 1)
-- callers in 0049), so the 4 storage policies + job_photos DELETE policy that
-- call it need no edits.
-- ---------------------------------------------------------------------------
create or replace function user_can_manage_job(job_id_text text)
returns boolean
language sql
security definer
set search_path = public, pg_temp
stable
as $$
  select is_office_or_admin(auth.uid())
      or exists (
           select 1
           from public.job_assignments ja
           where ja.job_id::text = job_id_text
             and ja.staff_id = auth.uid()
         );
$$;

comment on function user_can_manage_job(text) is
  'Office/admin, or any technician currently assigned to the job (job_assignments, '
  'not just jobs.assigned_to). The database half of canManageJobBilling '
  '(lib/api/job-authz.ts), and the same scope as the technician PowerSync '
  'streams (mobile/powersync/sync-streams.yaml). Takes text so storage '
  'policies can pass split_part(name, ''/'', 1) without a uuid cast that '
  'would RAISE on a non-uuid key rather than simply not matching. SECURITY '
  'DEFINER because an RLS policy body runs as the invoking user, so a bare '
  'subquery over job_assignments would be filtered by its own RLS -- a '
  'technician is only allowed to read their own rows there. If you change '
  'this rule, change the other two.';

-- ---------------------------------------------------------------------------
-- set_job_assignments -- the one place a caller replaces a job's whole
-- assignee set atomically. security invoker (the default) so job_assignments'
-- own RLS gates it: only office/admin can call it with effect. Returns the
-- resulting set so the caller can tell an RLS-silent no-op (a technician
-- calling this gets back an unchanged set, not an error) from a real write --
-- the same discipline lib/schedule-dispatch.ts already applies with
-- `count: "exact"` for the analogous jobs-table case.
-- ---------------------------------------------------------------------------
create or replace function set_job_assignments(p_job_id uuid, p_staff_ids uuid[])
returns table(staff_id uuid)
language plpgsql
set search_path = public, pg_temp
as $$
begin
  delete from job_assignments
  where job_id = p_job_id and staff_id <> all (p_staff_ids);

  insert into job_assignments (job_id, staff_id, assigned_by)
  select p_job_id, s, auth.uid() from unnest(p_staff_ids) as s
  on conflict (job_id, staff_id) do nothing;

  return query select ja.staff_id from job_assignments ja where ja.job_id = p_job_id;
end;
$$;

grant execute on function set_job_assignments(uuid, uuid[]) to authenticated;

-- Keep the scoped PowerSync publication in sync (see migration 0039) -- a
-- table missing here silently never replicates to any device.
alter publication powersync add table job_assignments;

-- ---------------------------------------------------------------------------
-- Assert the end state, and RAISE if it is not what was intended. A
-- migration that can silently achieve nothing is worse than no migration.
-- ---------------------------------------------------------------------------
do $$
declare
  n int;
begin
  select count(*) into n from job_assignments;
  if n = 0 and (select count(*) from jobs where assigned_to is not null) > 0 then
    raise exception 'job_assignments backfill did not populate any rows';
  end if;

  if not exists (
    select 1 from pg_trigger where tgname = 'job_assignments_sync_primary'
  ) then
    raise exception 'job_assignments_sync_primary trigger is missing';
  end if;

  if not exists (
    select 1 from pg_trigger where tgname = 'jobs_collapse_assignments'
  ) then
    raise exception 'jobs_collapse_assignments trigger is missing';
  end if;
end;
$$;
