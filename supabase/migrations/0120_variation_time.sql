-- ============================================================================
-- Time against variations: crew tag their hours to a variation on site, the
-- office links other costs to it, and the stage's allowed hours stay a fair
-- measure.
--
-- STATUS: DRAFT — NOT APPLIED
-- How: paste this file into the SQL editor, then the gate test
-- supabase/tests/0120_variation_time_test.sql, and trust only the final
-- "0120 PASSED" row. Then change this line to applied and add the ledger row:
--   insert into supabase_migrations.schema_migrations (version,name)
--   values ('0120','variation_time') on conflict do nothing;
-- THEN redeploy the PowerSync streams (tech_time_entries names variation_id —
-- docs/powersync-deploy.md). Not before: the stream would name a column the
-- database doesn't have.
--
-- WHY (Justin, 25 Nov 2026): a job's stages carry allowed hours (sewer and
-- stormwater, 16 h). When the crew hit rock the job runs well over. The extra
-- time must go against a VARIATION, so the variation can be costed and the
-- stage's allowed hours stay a fair measure. His decisions:
--   1. Charging is mixed and the office decides each one: an hourly variation
--      (its type's unit is an hour, or the office marks it so) takes its
--      quantity from the hours logged to it; others are per m³ or an agreed
--      price. Pricing and approval stay office-only (0028).
--   2. Crew on site tag the time (clock on to a variation, switch to one while
--      clocked on, move an entry on or off one); the office checks.
--   3. Variation time does NOT count toward the stage's allowed hours.
--
-- WHAT THIS DOES
--   time_entries.variation_id   the variation this time is for (null = the
--                               stage's own work). ON DELETE SET NULL. Granted
--                               to `authenticated` explicitly: time_entries has
--                               column-level SELECT grants (0045/0092). Not money
--                               — it is in the technicians' stream.
--   time_entries_variation_guard  BEFORE INSERT/UPDATE (SECURITY DEFINER — the
--                               crew can't read job_variations, 0028): the
--                               variation is on the SAME job as the entry; a
--                               travel entry can't be tagged; tagging onto a
--                               REJECTED variation is refused (an entry already
--                               on one is left alone by unrelated edits).
--   job_variations.is_hourly    office's call: true = charged by the hour,
--                               false = not, null = by the unit (an hour unit
--                               means hourly). Anyone but office/admin writing
--                               it is ignored (kept as it was / null on insert).
--   variation_cost_links        OFFICE/ADMIN ONLY. Plant (equipment_usage_log),
--                               expenses (job_expenses) and supplier POs
--                               (vendor_orders) the office links to a variation.
--                               A LINK, no amount stored (costed from the source
--                               the way the Job Ledger costs it, so it can't
--                               drift). A cost record links to at most one
--                               variation; the guard checks it is on the
--                               variation's job; deleting the record deletes the
--                               link. No money column.
--   job_variations_after_reject a variation the office REJECTS is not a
--                               variation: its time goes back to the stage
--                               (variation_id cleared) and its cost links are
--                               removed, so every report agrees.
--
-- MONEY: nothing here carries an amount. variation_cost_links is office/admin
-- by RLS (asserted) and in NO PowerSync stream / not in the powersync
-- publication (asserted). The job_variations money columns are untouched.
--
-- BEFORE THIS IS APPLIED nothing breaks: every reader that names variation_id
-- retries without it on 42703 / PGRST204 (and treats every entry as the
-- stage's); the phone's gateway drops variation_id from queued time-entry
-- writes (mobile/lib/data/optionalColumns.ts); the variation choices hide.
--
-- APPLY: paste this → paste the gate test (needs an active technician and an
-- active office/admin) → trust only "0120 PASSED" → mark applied, add the
-- ledger row, regenerate types (lib/database.types.ts has the column, the flag
-- and the table by hand) → redeploy the PowerSync streams → deploy the web →
-- ship the phone build.
-- ============================================================================

do $$
begin
  if to_regclass('public.job_variations') is null then
    raise exception '0120 needs 0004 (job_variations) applied first';
  end if;
  if to_regprocedure('public.is_office_or_admin(uuid)') is null then
    raise exception '0120 needs is_office_or_admin() (0027) applied first';
  end if;
  if to_regclass('public.vendor_orders') is null then
    raise exception '0120 needs 0061 (vendor_orders) applied first';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 1. time_entries.variation_id
-- ---------------------------------------------------------------------------
alter table time_entries add column if not exists variation_id uuid references job_variations(id) on delete set null;
create index if not exists time_entries_variation_id_idx on time_entries (variation_id) where variation_id is not null;

comment on column time_entries.variation_id is
  'The variation this time is for (0120). Null = the stage''s own work. Variation time does not count toward the stage''s allowed hours; it is costed on the variation. Not money.';

-- Column-level SELECT grants (0045): a new column is invisible until granted.
grant select (variation_id) on time_entries to authenticated;

create or replace function time_entries_variation_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_job uuid;
  v_status text;
begin
  if new.variation_id is null then
    return new;
  end if;
  select job_id, status into v_job, v_status from job_variations where id = new.variation_id;
  if not found then
    raise exception 'That variation doesn''t exist.' using errcode = 'foreign_key_violation';
  end if;
  if v_job is distinct from new.job_id then
    raise exception 'That variation is on another job.' using errcode = 'check_violation';
  end if;
  if new.entry_type = 'travel' then
    raise exception 'Travel time can''t go against a variation.' using errcode = 'check_violation';
  end if;
  if v_status = 'rejected'
     and (tg_op = 'INSERT' or new.variation_id is distinct from old.variation_id) then
    raise exception 'That variation was rejected — time can''t go against it.' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

revoke all on function time_entries_variation_guard() from public, anon, authenticated;

drop trigger if exists time_entries_variation_guard on time_entries;
create trigger time_entries_variation_guard
  before insert or update of variation_id, job_id, entry_type on time_entries
  for each row execute function time_entries_variation_guard();

-- ---------------------------------------------------------------------------
-- 2. job_variations.is_hourly (office's call)
-- ---------------------------------------------------------------------------
alter table job_variations add column if not exists is_hourly boolean;

comment on column job_variations.is_hourly is
  'Charged by the hour (0120): true / false is the office''s call; null = by the unit (an hour unit means hourly). An hourly variation''s quantity is filled from the hours logged to it. Not money.';

create or replace function job_variations_is_hourly_office_only()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.role() is distinct from 'authenticated' or is_office_or_admin(auth.uid()) then
    return new;
  end if;
  if tg_op = 'INSERT' then
    new.is_hourly := null;
  else
    new.is_hourly := old.is_hourly;
  end if;
  return new;
end;
$$;

revoke all on function job_variations_is_hourly_office_only() from public, anon, authenticated;

drop trigger if exists job_variations_is_hourly_office_only on job_variations;
create trigger job_variations_is_hourly_office_only
  before insert or update of is_hourly on job_variations
  for each row execute function job_variations_is_hourly_office_only();

-- ---------------------------------------------------------------------------
-- 3. variation_cost_links (office/admin only, no amount)
-- ---------------------------------------------------------------------------
create table if not exists variation_cost_links (
  id uuid primary key default gen_random_uuid(),
  variation_id uuid not null references job_variations(id) on delete cascade,
  source text not null,
  source_id uuid not null,
  created_by uuid references profiles(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now()
);

do $$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.variation_cost_links'::regclass and conname = 'variation_cost_links_source_check') then
    alter table variation_cost_links add constraint variation_cost_links_source_check check (source in
      ('job_expense', 'vendor_order', 'equipment_usage'));
  end if;
end $$;

create index if not exists variation_cost_links_variation_id_idx on variation_cost_links (variation_id);
-- A cost record is part of at most one variation (no double counting).
create unique index if not exists variation_cost_links_source_key on variation_cost_links (source, source_id);

comment on table variation_cost_links is
  'Costs linked to a variation (0120): plant, expenses, supplier POs. OFFICE/ADMIN ONLY. A link, no amount — costed from the source the way the Job Ledger costs it. Time is linked by time_entries.variation_id instead.';

create or replace function variation_cost_links_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_job uuid;
  v_status text;
  v_src_job uuid;
begin
  select job_id, status into v_job, v_status from job_variations where id = new.variation_id;
  if not found then
    raise exception 'That variation doesn''t exist.' using errcode = 'foreign_key_violation';
  end if;
  if v_status = 'rejected' then
    raise exception 'That variation was rejected — costs can''t go against it.' using errcode = 'check_violation';
  end if;
  v_src_job := case new.source
    when 'job_expense' then (select job_id from job_expenses where id = new.source_id)
    when 'vendor_order' then (select job_id from vendor_orders where id = new.source_id)
    when 'equipment_usage' then (select job_id from equipment_usage_log where id = new.source_id)
  end;
  if v_src_job is null or v_src_job is distinct from v_job then
    raise exception 'That cost isn''t on this variation''s job.' using errcode = 'check_violation';
  end if;
  if tg_op = 'INSERT' then
    if auth.uid() is not null then
      new.created_by := auth.uid();
    end if;
    new.created_at := now();
  else
    new.created_by := old.created_by;
    new.created_at := old.created_at;
  end if;
  return new;
end;
$$;

revoke all on function variation_cost_links_guard() from public, anon, authenticated;

drop trigger if exists variation_cost_links_guard on variation_cost_links;
create trigger variation_cost_links_guard before insert or update on variation_cost_links
  for each row execute function variation_cost_links_guard();

-- A deleted cost record takes its link with it.
create or replace function variation_links_follow_delete()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  delete from variation_cost_links where source = tg_argv[0] and source_id = old.id;
  return null;
end;
$$;

revoke all on function variation_links_follow_delete() from public, anon, authenticated;

drop trigger if exists variation_links_follow_delete on job_expenses;
create trigger variation_links_follow_delete after delete on job_expenses
  for each row execute function variation_links_follow_delete('job_expense');
drop trigger if exists variation_links_follow_delete on vendor_orders;
create trigger variation_links_follow_delete after delete on vendor_orders
  for each row execute function variation_links_follow_delete('vendor_order');
drop trigger if exists variation_links_follow_delete on equipment_usage_log;
create trigger variation_links_follow_delete after delete on equipment_usage_log
  for each row execute function variation_links_follow_delete('equipment_usage');

-- ---------------------------------------------------------------------------
-- 4. A rejected variation gives its time and costs back to the stage
-- ---------------------------------------------------------------------------
create or replace function job_variations_after_reject()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.status = 'rejected' and old.status is distinct from 'rejected' then
    update time_entries set variation_id = null where variation_id = new.id;
    delete from variation_cost_links where variation_id = new.id;
  end if;
  return null;
end;
$$;

revoke all on function job_variations_after_reject() from public, anon, authenticated;

drop trigger if exists job_variations_after_reject on job_variations;
create trigger job_variations_after_reject after update of status on job_variations
  for each row execute function job_variations_after_reject();

-- ---------------------------------------------------------------------------
-- 5. RLS and grants (0088: this project does not expose new tables by itself)
-- ---------------------------------------------------------------------------
alter table variation_cost_links enable row level security;

-- Converge: drop every policy on the new table by enumeration, then create the one.
do $$
declare p record;
begin
  for p in select polname from pg_policy where polrelid = 'public.variation_cost_links'::regclass loop
    execute format('drop policy %I on variation_cost_links', p.polname);
  end loop;
end $$;

create policy "variation cost links: office/admin manage" on variation_cost_links for all
  to authenticated
  using ((select is_office_or_admin(auth.uid())))
  with check ((select is_office_or_admin(auth.uid())));

grant select, insert, update, delete on variation_cost_links to authenticated;
grant all on variation_cost_links to service_role;
revoke all on variation_cost_links from anon;

-- ---------------------------------------------------------------------------
-- 5b. time_entries: a technician changes only their OWN time.
--
-- Found by this migration's gate test on production (26 Nov 2026): the table
-- carried an out-of-band policy "Authenticated users can manage time entries"
-- (FOR ALL, USING auth.role() = 'authenticated') in place of the baseline's
-- "Users can manage own time entries" — so any signed-in technician could
-- edit, move or delete anyone's time. No migration ever created it, so no
-- migration's drop-by-name could remove it. Converge by enumeration: drop
-- every PERMISSIVE policy (restrictive ones are kept), then create the rules
-- the app was built on, and assert them.
--   read:  your own entries, any entry on a job you can manage (the crew's
--          time on your job — the same scope as the tech_time_entries
--          stream), office/admin everything;
--   write: your own entries only; office/admin everything (0030).
-- ---------------------------------------------------------------------------
do $$
declare p record;
begin
  for p in select polname from pg_policy
            where polrelid = 'public.time_entries'::regclass and polpermissive loop
    execute format('drop policy %I on time_entries', p.polname);
  end loop;
end $$;

create policy "time entries: read own or crew" on time_entries for select
  to authenticated
  using (staff_id = (select auth.uid()) or user_can_manage_job(job_id::text));
create policy "time entries: add own" on time_entries for insert
  to authenticated
  with check (staff_id = (select auth.uid()));
create policy "time entries: change own" on time_entries for update
  to authenticated
  using (staff_id = (select auth.uid()))
  with check (staff_id = (select auth.uid()));
create policy "time entries: delete own" on time_entries for delete
  to authenticated
  using (staff_id = (select auth.uid()));
create policy "Office/admin manage all time entries" on time_entries for all
  to authenticated
  using ((select is_office_or_admin(auth.uid())))
  with check ((select is_office_or_admin(auth.uid())));

do $$
declare n int;
begin
  if not (select relrowsecurity from pg_class where oid = 'public.time_entries'::regclass) then
    raise exception '0120: RLS is off on time_entries';
  end if;
  select count(*) into n from pg_policy where polrelid = 'public.time_entries'::regclass and polpermissive;
  if n <> 5 then raise exception '0120: expected exactly 5 permissive policies on time_entries, found %', n; end if;
  -- Every permissive write policy is own-rows or office/admin — nothing open.
  select count(*) into n from pg_policy
   where polrelid = 'public.time_entries'::regclass and polpermissive and polcmd in ('a', 'w', 'd', '*')
     and position('is_office_or_admin' in coalesce(pg_get_expr(polqual, polrelid), '') || coalesce(pg_get_expr(polwithcheck, polrelid), '')) = 0
     and position('staff_id = ' in coalesce(pg_get_expr(polqual, polrelid), '') || coalesce(pg_get_expr(polwithcheck, polrelid), '')) = 0;
  if n > 0 then raise exception '0120: a time_entries write policy is neither own-rows nor office/admin'; end if;
  select count(*) into n from pg_policy
   where polrelid = 'public.time_entries'::regclass and polpermissive
     and coalesce(pg_get_expr(polqual, polrelid), '') ~* 'auth\.role\(\)';
  if n > 0 then raise exception '0120: a time_entries policy still lets any signed-in user through'; end if;
end $$;

-- ---------------------------------------------------------------------------
-- 6. Assert the end state
-- ---------------------------------------------------------------------------
do $$
declare
  n int;
  p record;
  t text;
  money_re text := '(rate|cost|price|amount|total|sell|margin|markup|hourly|salary|wage|charge'
                || '|fee|value|balance|paid|owing|gst|deposit|discount|surcharge|levy'
                || '|insurance|maintenance|registration|annual|subtotal|invoice_total)';
begin
  -- The column, its FK (set null) and the explicit grant.
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'time_entries' and column_name = 'variation_id') then
    raise exception '0120: time_entries.variation_id is missing';
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.time_entries'::regclass and contype = 'f'
                  and confrelid = 'public.job_variations'::regclass and confdeltype = 'n') then
    raise exception '0120: time_entries.variation_id does not reference job_variations on delete set null';
  end if;
  if not has_column_privilege('authenticated', 'public.time_entries', 'variation_id', 'SELECT') then
    raise exception '0120: authenticated cannot read time_entries.variation_id (column grants, 0045)';
  end if;
  if has_column_privilege('authenticated', 'public.time_entries', 'rate_override', 'SELECT') then
    raise exception '0120: rate_override became readable — 0045 broken';
  end if;
  if 'variation_id' ~* money_re then
    raise exception '0120: variation_id matches the money regex — it must not, it is in a technician stream';
  end if;

  -- The flag.
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'job_variations' and column_name = 'is_hourly') then
    raise exception '0120: job_variations.is_hourly is missing';
  end if;

  -- Triggers in place and enabled.
  if (select count(*) from pg_trigger where not tgisinternal and tgenabled <> 'D' and tgname in
        ('time_entries_variation_guard', 'job_variations_is_hourly_office_only', 'variation_cost_links_guard', 'job_variations_after_reject')) <> 4 then
    raise exception '0120: a variation trigger is missing or disabled';
  end if;
  if (select count(*) from pg_trigger where not tgisinternal and tgenabled <> 'D' and tgname = 'variation_links_follow_delete') <> 3 then
    raise exception '0120: a variation_links_follow_delete trigger is missing or disabled';
  end if;
  foreach t in array array['time_entries_variation_guard()', 'job_variations_is_hourly_office_only()', 'variation_cost_links_guard()',
                           'variation_links_follow_delete()', 'job_variations_after_reject()'] loop
    if not (select prosecdef from pg_proc where oid = ('public.' || t)::regprocedure) then
      raise exception '0120: % is not SECURITY DEFINER', t;
    end if;
    if has_function_privilege('authenticated', 'public.' || t, 'execute') or has_function_privilege('anon', 'public.' || t, 'execute') then
      raise exception '0120: a client can run %', t;
    end if;
  end loop;

  -- The link table: RLS on, exactly one FOR ALL office/admin policy, grants, no money, not synced.
  if not (select relrowsecurity from pg_class where oid = 'public.variation_cost_links'::regclass) then
    raise exception '0120: RLS is off on variation_cost_links';
  end if;
  select count(*) into n from pg_policy where polrelid = 'public.variation_cost_links'::regclass;
  if n <> 1 then raise exception '0120: expected exactly 1 policy on variation_cost_links, found %', n; end if;
  select polcmd, polpermissive, pg_get_expr(polqual, polrelid) as q, pg_get_expr(polwithcheck, polrelid) as w
    into p from pg_policy where polrelid = 'public.variation_cost_links'::regclass;
  if p.polcmd <> '*' or not p.polpermissive
     or position('is_office_or_admin' in coalesce(p.q, '')) = 0 or position('is_office_or_admin' in coalesce(p.w, '')) = 0 then
    raise exception '0120: the variation_cost_links policy is not FOR ALL office/admin (USING and WITH CHECK)';
  end if;
  if has_table_privilege('anon', 'public.variation_cost_links', 'SELECT') then
    raise exception '0120: anon can read variation_cost_links';
  end if;
  if not (has_table_privilege('authenticated', 'public.variation_cost_links', 'SELECT')
      and has_table_privilege('authenticated', 'public.variation_cost_links', 'INSERT')
      and has_table_privilege('authenticated', 'public.variation_cost_links', 'DELETE')
      and has_table_privilege('service_role', 'public.variation_cost_links', 'SELECT')) then
    raise exception '0120: variation_cost_links lacks a grant';
  end if;
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'variation_cost_links' and column_name ~* money_re) then
    raise exception '0120: variation_cost_links carries a money-named column';
  end if;
  if exists (select 1 from pg_publication_tables where pubname = 'powersync' and schemaname = 'public' and tablename = 'variation_cost_links') then
    raise exception '0120: variation_cost_links is in the powersync publication — it must not reach devices';
  end if;

  -- job_variations' own policies are untouched: reads, edits and deletes stay office/admin.
  select count(*) into n from pg_policy
   where polrelid = 'public.job_variations'::regclass and polcmd in ('r', 'w', 'd', '*')
     and position('is_office_or_admin' in coalesce(pg_get_expr(polqual, polrelid), '')) = 0;
  if n > 0 then raise exception '0120: a job_variations read/edit/delete policy is not office/admin'; end if;
end $$;

notify pgrst, 'reload schema';

select '0120 APPLIED — now run supabase/tests/0120_variation_time_test.sql' as result;
