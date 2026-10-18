-- ============================================================================
-- Technician write scope: assigned jobs only, office-only customer edits,
-- no technician deletes of compliance records, audited time entries.
--
-- STATUS: ✅ APPLIED IN PRODUCTION (2026-10-18, via SQL editor, one at a time in order
-- 0073 → 0076). Verified afterwards (read-only): ledger row present,
-- all 3 triggers installed, time_entry_changes exists. Gate test
-- supabase/tests/0074_technician_write_scope_test.sql passed.
--
-- WHY
-- The 17 Oct 2026 audit found nine tables still governed by the baseline
-- `for all using (auth.role() = 'authenticated')` policy, so any signed-in
-- technician could rewrite or delete any customer, any job, any backflow test,
-- any note — directly through PostgREST with the anon key that ships in the
-- app, whatever the UI shows. Rules agreed with Justin, 17 Oct 2026:
--
--   customers        technicians read; only office/admin edit or delete
--   jobs             technicians change only jobs they are assigned to; only
--                    office/admin create jobs; admin_status / admin_notes are
--                    office-only; ready_to_invoice may only be SET by a tech
--                    (job sign-off), never cleared
--   backflow         technicians register devices and record/edit tests; only
--                    office/admin delete either, or deactivate a device
--                    (deleting a device cascades its whole test history)
--   time entries     technicians keep editing their own, but every change is
--                    recorded in time_entry_changes, and once an entry has been
--                    billed onto a job_items line only office/admin may change
--                    or delete it
--
-- Plus the related holes from the same audit:
--   job_photos       0049 scoped DELETE to the job, but UPDATE was open, so a
--                    tech could re-point a photo row at their own job and then
--                    delete it. Insert/update now need the job too.
--   job_documents    deletes/updates (row and file) scoped to the job, as 0049
--                    did for photos and audio.
--   job_notes,
--   job_stage_notes  add on your jobs; edit/delete only your own note.
--   equipment_usage_log  only on jobs you can manage.
--   equipment_documents, cost_center_templates  office-only writes (no
--                    technician screen writes either).
--
-- HOW
-- Every rule here is a RESTRICTIVE policy or a trigger layered on the existing
-- permissive policies, which are left untouched. Restrictive policies AND with
-- the permissive set, so this can only remove access, never grant it, and the
-- 0053/0069 policy rewrites need no edits. Service-role API routes (which
-- authorise the caller themselves) bypass RLS and, via the
-- `auth.role() is distinct from 'authenticated'` early return, the triggers —
-- same convention as enforce_job_assignment_office_only (0049).
--
-- user_can_manage_job() (0059) is office/admin OR any current assignee — the
-- same scope as canManageJobBilling and the technician PowerSync streams.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- customers
-- ---------------------------------------------------------------------------
drop policy if exists "customers: only office/admin update" on customers;
create policy "customers: only office/admin update"
  on customers as restrictive for update to authenticated
  using ((select is_office_or_admin(auth.uid())))
  with check ((select is_office_or_admin(auth.uid())));

drop policy if exists "customers: only office/admin delete" on customers;
create policy "customers: only office/admin delete"
  on customers as restrictive for delete to authenticated
  using ((select is_office_or_admin(auth.uid())));

-- ---------------------------------------------------------------------------
-- jobs
-- ---------------------------------------------------------------------------
drop policy if exists "jobs: only office/admin create" on jobs;
create policy "jobs: only office/admin create"
  on jobs as restrictive for insert to authenticated
  with check ((select is_office_or_admin(auth.uid())));

drop policy if exists "jobs: change only jobs you can manage" on jobs;
create policy "jobs: change only jobs you can manage"
  on jobs as restrictive for update to authenticated
  using ((select user_can_manage_job(id::text)))
  with check ((select user_can_manage_job(id::text)));

create or replace function enforce_job_office_columns()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.role() is distinct from 'authenticated' then
    return new;
  end if;
  if is_office_or_admin(auth.uid()) then
    return new;
  end if;

  if new.admin_status is distinct from old.admin_status
     or new.admin_notes is distinct from old.admin_notes then
    raise exception 'jobs.admin_status and admin_notes are office/admin-only'
      using errcode = '42501';
  end if;

  -- Sign-off (mobile signature.ts, web job-signature.tsx) sets it true. Nothing
  -- a technician does legitimately clears it.
  if old.ready_to_invoice is true and new.ready_to_invoice is not true then
    raise exception 'only office/admin may clear jobs.ready_to_invoice'
      using errcode = '42501';
  end if;

  return new;
end;
$$;

drop trigger if exists jobs_office_columns on jobs;
create trigger jobs_office_columns
  before update on jobs
  for each row execute function enforce_job_office_columns();

-- ---------------------------------------------------------------------------
-- job_notes / job_stage_notes
-- ---------------------------------------------------------------------------
drop policy if exists "job notes: add only on jobs you can manage" on job_notes;
create policy "job notes: add only on jobs you can manage"
  on job_notes as restrictive for insert to authenticated
  with check ((select user_can_manage_job(job_id::text)));

drop policy if exists "job notes: edit only your own" on job_notes;
create policy "job notes: edit only your own"
  on job_notes as restrictive for update to authenticated
  using (author_id = (select auth.uid()) or (select is_office_or_admin(auth.uid())))
  with check (author_id = (select auth.uid()) or (select is_office_or_admin(auth.uid())));

drop policy if exists "job notes: delete only your own" on job_notes;
create policy "job notes: delete only your own"
  on job_notes as restrictive for delete to authenticated
  using (author_id = (select auth.uid()) or (select is_office_or_admin(auth.uid())));

drop policy if exists "job stage notes: add only on jobs you can manage" on job_stage_notes;
create policy "job stage notes: add only on jobs you can manage"
  on job_stage_notes as restrictive for insert to authenticated
  with check ((select user_can_manage_job(job_id::text)));

drop policy if exists "job stage notes: edit only your own" on job_stage_notes;
create policy "job stage notes: edit only your own"
  on job_stage_notes as restrictive for update to authenticated
  using (author_id = (select auth.uid()) or (select is_office_or_admin(auth.uid())))
  with check (author_id = (select auth.uid()) or (select is_office_or_admin(auth.uid())));

drop policy if exists "job stage notes: delete only your own" on job_stage_notes;
create policy "job stage notes: delete only your own"
  on job_stage_notes as restrictive for delete to authenticated
  using (author_id = (select auth.uid()) or (select is_office_or_admin(auth.uid())));

-- ---------------------------------------------------------------------------
-- backflow_devices / backflow_tests
-- ---------------------------------------------------------------------------
drop policy if exists "backflow devices: only office/admin delete" on backflow_devices;
create policy "backflow devices: only office/admin delete"
  on backflow_devices as restrictive for delete to authenticated
  using ((select is_office_or_admin(auth.uid())));

drop policy if exists "backflow tests: only office/admin delete" on backflow_tests;
create policy "backflow tests: only office/admin delete"
  on backflow_tests as restrictive for delete to authenticated
  using ((select is_office_or_admin(auth.uid())));

-- The web "Delete" button soft-deletes (is_active = false); that is a delete in
-- everything but name, so it gets the same rule.
create or replace function enforce_backflow_device_deactivation_office_only()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.role() is distinct from 'authenticated' then
    return new;
  end if;
  if new.is_active is distinct from old.is_active and not is_office_or_admin(auth.uid()) then
    raise exception 'only office/admin may deactivate or reactivate a backflow device'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists backflow_devices_deactivation_office_only on backflow_devices;
create trigger backflow_devices_deactivation_office_only
  before update on backflow_devices
  for each row execute function enforce_backflow_device_deactivation_office_only();

-- ---------------------------------------------------------------------------
-- equipment_usage_log / equipment_documents / cost_center_templates
-- ---------------------------------------------------------------------------
drop policy if exists "equipment usage: only on jobs you can manage" on equipment_usage_log;
create policy "equipment usage: only on jobs you can manage"
  on equipment_usage_log as restrictive for all to authenticated
  using (
    (select is_office_or_admin(auth.uid()))
    or (job_id is not null and (select user_can_manage_job(job_id::text)))
  )
  with check (
    (select is_office_or_admin(auth.uid()))
    or (job_id is not null and (select user_can_manage_job(job_id::text)))
  );

-- `for all` would also restrict SELECT, which these tables keep open; so one
-- restrictive policy per write command.
drop policy if exists "equipment documents: office/admin insert" on equipment_documents;
create policy "equipment documents: office/admin insert"
  on equipment_documents as restrictive for insert to authenticated
  with check ((select is_office_or_admin(auth.uid())));
drop policy if exists "equipment documents: office/admin update" on equipment_documents;
create policy "equipment documents: office/admin update"
  on equipment_documents as restrictive for update to authenticated
  using ((select is_office_or_admin(auth.uid())))
  with check ((select is_office_or_admin(auth.uid())));
drop policy if exists "equipment documents: office/admin delete" on equipment_documents;
create policy "equipment documents: office/admin delete"
  on equipment_documents as restrictive for delete to authenticated
  using ((select is_office_or_admin(auth.uid())));

drop policy if exists "cost centre templates: office/admin insert" on cost_center_templates;
create policy "cost centre templates: office/admin insert"
  on cost_center_templates as restrictive for insert to authenticated
  with check ((select is_office_or_admin(auth.uid())));
drop policy if exists "cost centre templates: office/admin update" on cost_center_templates;
create policy "cost centre templates: office/admin update"
  on cost_center_templates as restrictive for update to authenticated
  using ((select is_office_or_admin(auth.uid())))
  with check ((select is_office_or_admin(auth.uid())));
drop policy if exists "cost centre templates: office/admin delete" on cost_center_templates;
create policy "cost centre templates: office/admin delete"
  on cost_center_templates as restrictive for delete to authenticated
  using ((select is_office_or_admin(auth.uid())));

-- ---------------------------------------------------------------------------
-- job_photos (rows) — insert/update scoped like 0049's delete
-- ---------------------------------------------------------------------------
drop policy if exists "job photo rows: add only on jobs you can manage" on job_photos;
create policy "job photo rows: add only on jobs you can manage"
  on job_photos as restrictive for insert to authenticated
  with check ((select user_can_manage_job(job_id::text)));

drop policy if exists "job photo rows: change only on jobs you can manage" on job_photos;
create policy "job photo rows: change only on jobs you can manage"
  on job_photos as restrictive for update to authenticated
  using ((select user_can_manage_job(job_id::text)))
  with check ((select user_can_manage_job(job_id::text)));

-- ---------------------------------------------------------------------------
-- job_documents (rows and files)
-- ---------------------------------------------------------------------------
drop policy if exists "job document rows: add only on jobs you can manage" on job_documents;
create policy "job document rows: add only on jobs you can manage"
  on job_documents as restrictive for insert to authenticated
  with check ((select user_can_manage_job(job_id::text)));

drop policy if exists "job document rows: change only on jobs you can manage" on job_documents;
create policy "job document rows: change only on jobs you can manage"
  on job_documents as restrictive for update to authenticated
  using ((select user_can_manage_job(job_id::text)))
  with check ((select user_can_manage_job(job_id::text)));

drop policy if exists "job document rows: delete only on jobs you can manage" on job_documents;
create policy "job document rows: delete only on jobs you can manage"
  on job_documents as restrictive for delete to authenticated
  using ((select user_can_manage_job(job_id::text)));

-- Files are stored as {jobId}/... (job-documents.tsx, job-expenses.tsx,
-- job-variations.tsx, scripts/sync-simpro-attachments.mjs). Restrictive on
-- storage.objects, so the condition must pass every OTHER bucket untouched.
drop policy if exists "job documents: delete only on jobs you can manage" on storage.objects;
create policy "job documents: delete only on jobs you can manage"
  on storage.objects as restrictive for delete to authenticated
  using (bucket_id <> 'job-documents' or (select user_can_manage_job(split_part(name, '/', 1))));

drop policy if exists "job documents: replace only on jobs you can manage" on storage.objects;
create policy "job documents: replace only on jobs you can manage"
  on storage.objects as restrictive for update to authenticated
  using (bucket_id <> 'job-documents' or (select user_can_manage_job(split_part(name, '/', 1))))
  with check (bucket_id <> 'job-documents' or (select user_can_manage_job(split_part(name, '/', 1))));

-- ---------------------------------------------------------------------------
-- time_entries — audit every change; billed entries are office-only
-- ---------------------------------------------------------------------------
create table if not exists time_entry_changes (
  id bigint generated always as identity primary key,
  time_entry_id uuid not null,
  operation text not null check (operation in ('UPDATE', 'DELETE')),
  changed_by uuid,              -- null = service role / SQL editor
  changed_at timestamptz not null default now(),
  -- Whole row minus rate_override: 0045 made that column admin-only, and an
  -- audit copy must not become a second way to read it.
  old_row jsonb not null,
  new_row jsonb
);
create index if not exists time_entry_changes_entry_idx on time_entry_changes (time_entry_id, changed_at desc);

alter table time_entry_changes enable row level security;
-- Readable by office/admin; nobody writes it directly — only the trigger below
-- (SECURITY DEFINER) does.
drop policy if exists "time entry changes: office/admin read" on time_entry_changes;
create policy "time entry changes: office/admin read"
  on time_entry_changes for select to authenticated
  using ((select is_office_or_admin(auth.uid())));
revoke all on time_entry_changes from anon, public;
revoke insert, update, delete on time_entry_changes from authenticated;
grant select on time_entry_changes to authenticated;

create or replace function enforce_and_audit_time_entry_change()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  is_user boolean := auth.role() is not distinct from 'authenticated';
begin
  -- Billed entries: only office/admin. The 1:1 link is job_items.time_entry_id
  -- (0024), written by lib/labour-billing-sync.ts.
  if is_user
     and not is_office_or_admin(auth.uid())
     and exists (select 1 from job_items where time_entry_id = old.id) then
    raise exception 'this time entry has been billed — ask the office to change it'
      using errcode = '42501';
  end if;

  if tg_op = 'UPDATE' then
    if new is not distinct from old then
      return new;
    end if;
    -- Stamp the editor in the database, not just the app (time.tsx and
    -- time-entry-edit-dialog.tsx set these client-side today).
    if is_user and (new.clock_in is distinct from old.clock_in
                    or new.clock_out is distinct from old.clock_out
                    or new.hours is distinct from old.hours) then
      new.edited_by := auth.uid();
      new.edited_at := now();
    end if;
    insert into time_entry_changes (time_entry_id, operation, changed_by, old_row, new_row)
    values (old.id, 'UPDATE', auth.uid(), to_jsonb(old) - 'rate_override', to_jsonb(new) - 'rate_override');
    return new;
  end if;

  insert into time_entry_changes (time_entry_id, operation, changed_by, old_row, new_row)
  values (old.id, 'DELETE', auth.uid(), to_jsonb(old) - 'rate_override', null);
  return old;
end;
$$;

drop trigger if exists time_entries_enforce_and_audit on time_entries;
create trigger time_entries_enforce_and_audit
  before update or delete on time_entries
  for each row execute function enforce_and_audit_time_entry_change();

revoke execute on function enforce_job_office_columns() from public, anon, authenticated;
revoke execute on function enforce_backflow_device_deactivation_office_only() from public, anon, authenticated;
revoke execute on function enforce_and_audit_time_entry_change() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Assert the end state
-- ---------------------------------------------------------------------------
do $$
declare
  r record;
  n int;
begin
  for r in
    select * from (values
      ('customers', 2), ('jobs', 3), ('job_notes', 3), ('job_stage_notes', 3),
      ('backflow_devices', 1), ('backflow_tests', 1), ('equipment_usage_log', 1),
      ('equipment_documents', 3), ('cost_center_templates', 3),
      ('job_photos', 3), ('job_documents', 3)
    ) as t(tbl, min_restrictive)
  loop
    select count(*) into n from pg_policy
     where polrelid = ('public.' || r.tbl)::regclass and not polpermissive;
    if n < r.min_restrictive then
      raise exception 'ASSERTION FAILED: % has % restrictive policies, expected at least %',
        r.tbl, n, r.min_restrictive;
    end if;
  end loop;

  select count(*) into n from pg_trigger
   where not tgisinternal
     and tgname in ('jobs_office_columns', 'backflow_devices_deactivation_office_only',
                    'time_entries_enforce_and_audit');
  if n <> 3 then
    raise exception 'ASSERTION FAILED: expected 3 new triggers, found %', n;
  end if;

  if has_table_privilege('authenticated', 'public.time_entry_changes', 'insert') then
    raise exception 'ASSERTION FAILED: clients can write the time entry audit log';
  end if;
end;
$$;
