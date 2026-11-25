-- ============================================================================
-- Cost of mistakes, stages 1–4: crew raise, office costs, links to the costs
-- the CRM already holds, recovery, and an admin-only "whose mistake".
--
-- STATUS: ✅ APPLIED 2026-11-25 (gate test passed).
-- How: paste this file into the SQL editor, then the gate test
-- supabase/tests/0119_mistake_tracking_test.sql, and trust only the final
-- "0119 PASSED" row. Then change this line to applied and add the ledger row:
--   insert into supabase_migrations.schema_migrations (version,name)
--   values ('0119','mistake_tracking') on conflict do nothing;
--
-- WHY (Justin, 25 Nov 2026): record every mistake — rework, wrong materials,
-- damage, callbacks, mis-quotes, missed inspections — against a job and cost
-- centre with its true cost, so he sees where money leaks and why. DO NOT
-- DOUBLE-ENTER COST: a mistake is a tag plus links over costs the CRM already
-- holds (time entries, expenses, supplier POs, equipment usage, Day Works),
-- plus a manual cost line only where no record exists. His decisions:
--   1. Crew raise, office costs. Any role logs a mistake on a job they're on
--      (category, stage, what happened, photos, their own rework time). Crew
--      never enter or see dollars. Office/admin add cost lines, recovery and
--      close it.
--   2. No "Rework" cost centre — a tag only; the real cost centre keeps its
--      true cost.
--   3. Callbacks are a mistake on the original job (closed jobs included).
--
-- WHAT THIS DOES (0115's job_mistakes evolves — 0115 itself is never edited)
--   job_mistakes        job_id now NULLABLE (a mistake with no job — truck or
--                       plant overhead — names a company cost centre only);
--                       + cost_centre_id (company cost centre, cost_centres;
--                       derived from the PO line when there is one), category_id,
--                       cause_code (fixed list), raised_by / raised_at, status
--                       open → costed → closed (closed_at), supplier_id, and
--                       the RECOVERY columns (supplier credit / builder
--                       recharge / insurance: claimed, received, note).
--                       amount_ex_gst becomes nullable and DEPRECATED: the
--                       cost lives in mistake_cost_lines. Existing amounts are
--                       copied into one "legacy" manual line each, and the two
--                       are kept in step by triggers, so the web build before
--                       this migration still reads and writes correct totals
--                       until the new one is deployed.
--                       `cause` (free text) stays as the cause NOTES.
--                       `staff_id` ("whose mistake") moves to the ADMIN-ONLY
--                       mistake_responsibility and is always null from now on
--                       (a trigger moves an admin's write and drops anyone
--                       else's).
--   mistake_categories  the editable list (Settings → Mistake categories).
--                       Everyone signed in reads it (the crew pick one);
--                       office/admin write. No money.
--   mistake_cost_lines  OFFICE/ADMIN ONLY. A line is either a LINK to an
--                       existing cost record (time_entry / job_expense /
--                       vendor_order / equipment_usage / hire_entry — its
--                       amount is worked out from the source the way the Job
--                       Ledger costs it, never copied, so it can't drift) or
--                       MANUAL (amount ex GST, optional hours). A cost record
--                       links to at most one mistake. Deleting the source
--                       deletes its links.
--   mistake_photos      photos (job-photos bucket, <job>/mistakes/<id>/…).
--                       Office/admin by RLS; the crew add theirs through
--                       add_job_mistake_photo().
--   mistake_responsibility  whose mistake: ADMIN ONLY (not office).
--
--   raise_job_mistake()     SECURITY DEFINER — the crew's one door. Caller
--                           active and on the job (user_can_manage_job), or
--                           office/admin; category active; stage on that job;
--                           their OWN work time entries on that job become
--                           linked labour lines. Idempotent on the client id.
--                           Returns only the id.
--   my_job_mistakes()       SECURITY DEFINER — the mistakes the caller raised
--                           on a job, money-free columns only.
--   add_job_mistake_photo() SECURITY DEFINER — the raiser (or office) files a
--                           photo already uploaded at the mistake's path.
--
-- MONEY: technicians read job_mistakes, mistake_cost_lines, mistake_photos and
-- mistake_responsibility not at all (RLS, asserted). The money columns
-- (amount_ex_gst on both tables, recovery_claimed_ex_gst, recovered_ex_gst)
-- match the money sweep's regex (asserted); supabase/ci/seed-roles.sql seeds a
-- cost line and a recovery so the sweep checks real data. In NO PowerSync
-- stream and not in the powersync publication (asserted) — sync-streams.yaml
-- untouched, no redeploy.
--
-- BEFORE THIS IS APPLIED nothing breaks: every reader treats a missing table or
-- column (42P01 / PGRST205 / 42703 / PGRST204) as "mistake tracking isn't
-- switched on yet" and falls back to 0115's single amount; the crew's Log
-- mistake answers that it isn't switched on (42883 / PGRST202).
--
-- APPLY: paste this → paste the gate test (needs an active technician and an
-- active admin; office-only checks run when an office user exists) → trust
-- only "0119 PASSED" → mark applied, add the ledger row, regenerate types
-- (lib/database.types.ts has the new tables and columns by hand) → deploy the
-- web → ship the phone build. No PowerSync redeploy.
-- ============================================================================

do $$
begin
  if to_regclass('public.job_mistakes') is null then
    raise exception '0119 needs 0115 (job_mistakes) applied first';
  end if;
  if to_regclass('public.cost_centres') is null then
    raise exception '0119 needs 0087 (cost_centres) applied first';
  end if;
  if to_regclass('public.hire_entries') is null then
    raise exception '0119 needs 0108 (hire_entries) applied first';
  end if;
  if to_regprocedure('public.user_can_manage_job(text)') is null then
    raise exception '0119 needs user_can_manage_job() applied first';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 1. Categories (editable list)
-- ---------------------------------------------------------------------------
create table if not exists mistake_categories (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  sort_order int not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

do $$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.mistake_categories'::regclass and conname = 'mistake_categories_name_length') then
    alter table mistake_categories add constraint mistake_categories_name_length check (char_length(btrim(name)) between 1 and 80);
  end if;
end $$;

create unique index if not exists mistake_categories_name_key on mistake_categories (lower(btrim(name)));

insert into mistake_categories (name, sort_order)
select v.name, v.ord
  from (values
    ('Wrong material ordered', 10),
    ('Wrong material supplied', 20),
    ('Install error (rework)', 30),
    ('Damage (own or third party)', 40),
    ('Callback', 50),
    ('Mis-quote or missed scope', 60),
    ('Missed inspection or compliance', 70),
    ('Wrong supplier (dearer)', 80),
    ('Plant or cartage waste', 90),
    ('Other', 100)
  ) as v(name, ord)
 where not exists (select 1 from mistake_categories c where lower(btrim(c.name)) = lower(v.name));

comment on table mistake_categories is
  'Mistake categories (0119), edited in Settings → Mistake categories. Read by everyone signed in; office/admin write. No money.';

-- ---------------------------------------------------------------------------
-- 2. job_mistakes grows up
-- ---------------------------------------------------------------------------
alter table job_mistakes alter column job_id drop not null;
alter table job_mistakes alter column amount_ex_gst drop not null;

alter table job_mistakes add column if not exists cost_centre_id uuid references cost_centres(id) on delete set null;
alter table job_mistakes add column if not exists category_id uuid references mistake_categories(id) on delete set null;
alter table job_mistakes add column if not exists cause_code text;
alter table job_mistakes add column if not exists raised_by uuid references profiles(id) on delete set null;
alter table job_mistakes add column if not exists raised_at timestamptz;
alter table job_mistakes add column if not exists status text not null default 'open';
alter table job_mistakes add column if not exists closed_at timestamptz;
alter table job_mistakes add column if not exists supplier_id uuid references suppliers(id) on delete set null;
alter table job_mistakes add column if not exists recovery_source text;
alter table job_mistakes add column if not exists recovery_claimed_ex_gst numeric(12,2);
alter table job_mistakes add column if not exists recovered_ex_gst numeric(12,2);
alter table job_mistakes add column if not exists recovery_claimed_on date;
alter table job_mistakes add column if not exists recovery_note text;

do $$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.job_mistakes'::regclass and conname = 'job_mistakes_status_check') then
    alter table job_mistakes add constraint job_mistakes_status_check check (status in ('open', 'costed', 'closed'));
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.job_mistakes'::regclass and conname = 'job_mistakes_cause_code_check') then
    alter table job_mistakes add constraint job_mistakes_cause_code_check check (cause_code is null or cause_code in
      ('quoting', 'ordering', 'supplier', 'install', 'communication_handover', 'plans_builder_change', 'site_conditions', 'other'));
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.job_mistakes'::regclass and conname = 'job_mistakes_recovery_source_check') then
    alter table job_mistakes add constraint job_mistakes_recovery_source_check check (recovery_source is null or recovery_source in
      ('supplier_credit', 'builder_recharge', 'insurance', 'other'));
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.job_mistakes'::regclass and conname = 'job_mistakes_recovery_amounts') then
    alter table job_mistakes add constraint job_mistakes_recovery_amounts check (
      (recovery_claimed_ex_gst is null or recovery_claimed_ex_gst >= 0) and (recovered_ex_gst is null or recovered_ex_gst >= 0));
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.job_mistakes'::regclass and conname = 'job_mistakes_recovery_note_length') then
    alter table job_mistakes add constraint job_mistakes_recovery_note_length check (recovery_note is null or char_length(recovery_note) <= 1000);
  end if;
  -- No job → a company cost centre and no PO line. (Checked by the guard too,
  -- with a sentence; this is the backstop.)
  if not exists (select 1 from pg_constraint where conrelid = 'public.job_mistakes'::regclass and conname = 'job_mistakes_jobless_shape') then
    alter table job_mistakes add constraint job_mistakes_jobless_shape check (
      job_id is not null or (cost_center_id is null and cost_centre_id is not null));
  end if;
end $$;

create index if not exists job_mistakes_status_idx on job_mistakes (status);
create index if not exists job_mistakes_raised_by_idx on job_mistakes (raised_by);
create index if not exists job_mistakes_cost_centre_id_idx on job_mistakes (cost_centre_id);
create index if not exists job_mistakes_category_id_idx on job_mistakes (category_id);
create index if not exists job_mistakes_supplier_id_idx on job_mistakes (supplier_id);

comment on column job_mistakes.job_id is 'The job (null = no job: an overhead mistake, e.g. truck or plant — then cost_centre_id is required).';
comment on column job_mistakes.cost_centre_id is 'Company cost centre (cost_centres). Derived from the PO line when there is one (0119).';
comment on column job_mistakes.amount_ex_gst is 'DEPRECATED (0119): the cost lives in mistake_cost_lines. Kept in step with this mistake''s legacy manual line for readers built before 0119.';
comment on column job_mistakes.cause is 'Cause notes (free text). The fixed cause is cause_code (0119).';
comment on column job_mistakes.staff_id is 'DEPRECATED (0119): always null. Whose mistake is mistake_responsibility (admin only).';
comment on column job_mistakes.recovered_ex_gst is 'Recovery RECEIVED, ex GST (supplier credit / builder recharge / insurance). Net cost = cost lines − this.';
comment on column job_mistakes.recovery_claimed_ex_gst is 'Recovery CLAIMED, ex GST.';

-- ---------------------------------------------------------------------------
-- 3. Cost lines, photos, responsibility
-- ---------------------------------------------------------------------------
create table if not exists mistake_cost_lines (
  id uuid primary key default gen_random_uuid(),
  mistake_id uuid not null references job_mistakes(id) on delete cascade,
  kind text not null,
  source text not null,
  source_id uuid,
  hours numeric(8,2),
  amount_ex_gst numeric(12,2),
  note text,
  legacy boolean not null default false,
  created_by uuid references profiles(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

do $$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.mistake_cost_lines'::regclass and conname = 'mistake_cost_lines_kind_check') then
    alter table mistake_cost_lines add constraint mistake_cost_lines_kind_check check (kind in
      ('labour', 'material', 'plant', 'cartage', 'subcontractor', 'other'));
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.mistake_cost_lines'::regclass and conname = 'mistake_cost_lines_source_check') then
    alter table mistake_cost_lines add constraint mistake_cost_lines_source_check check (source in
      ('time_entry', 'job_expense', 'vendor_order', 'equipment_usage', 'hire_entry', 'manual'));
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.mistake_cost_lines'::regclass and conname = 'mistake_cost_lines_shape') then
    alter table mistake_cost_lines add constraint mistake_cost_lines_shape check (
      (source = 'manual' and source_id is null and amount_ex_gst is not null and amount_ex_gst > 0)
      or (source <> 'manual' and source_id is not null and amount_ex_gst is null and not legacy
          and (hours is null or source = 'time_entry')));
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.mistake_cost_lines'::regclass and conname = 'mistake_cost_lines_hours_positive') then
    alter table mistake_cost_lines add constraint mistake_cost_lines_hours_positive check (hours is null or hours > 0);
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.mistake_cost_lines'::regclass and conname = 'mistake_cost_lines_note_length') then
    alter table mistake_cost_lines add constraint mistake_cost_lines_note_length check (note is null or char_length(note) <= 500);
  end if;
end $$;

create index if not exists mistake_cost_lines_mistake_id_idx on mistake_cost_lines (mistake_id);
-- A cost record is part of at most one mistake (no double counting).
create unique index if not exists mistake_cost_lines_source_key on mistake_cost_lines (source, source_id) where source_id is not null;
create unique index if not exists mistake_cost_lines_legacy_key on mistake_cost_lines (mistake_id) where legacy;

comment on table mistake_cost_lines is
  'What a mistake cost (0119). OFFICE/ADMIN ONLY. A LINK to a cost the CRM already holds (amount worked out from the source, already in job cost) or MANUAL (amount ex GST — the only kind that adds cost).';

create table if not exists mistake_photos (
  id uuid primary key default gen_random_uuid(),
  mistake_id uuid not null references job_mistakes(id) on delete cascade,
  storage_path text not null,
  created_by uuid references profiles(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now()
);
create unique index if not exists mistake_photos_path_key on mistake_photos (storage_path);
create index if not exists mistake_photos_mistake_id_idx on mistake_photos (mistake_id);
comment on table mistake_photos is
  'Photos of a mistake, in the job-photos bucket at <job>/mistakes/<mistake>/… (0119). Office/admin read; the crew add theirs through add_job_mistake_photo().';

create table if not exists mistake_responsibility (
  mistake_id uuid primary key references job_mistakes(id) on delete cascade,
  staff_id uuid not null references profiles(id) on delete cascade,
  note text,
  set_by uuid references profiles(id) on delete set null default auth.uid(),
  set_at timestamptz not null default now()
);
do $$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.mistake_responsibility'::regclass and conname = 'mistake_responsibility_note_length') then
    alter table mistake_responsibility add constraint mistake_responsibility_note_length check (note is null or char_length(note) <= 500);
  end if;
end $$;
create index if not exists mistake_responsibility_staff_id_idx on mistake_responsibility (staff_id);
comment on table mistake_responsibility is 'Whose mistake it was (0119). ADMIN ONLY — not office, never technicians.';

-- ---------------------------------------------------------------------------
-- 4. Carry the 0115 rows over (re-runnable: every step is "where not yet")
-- ---------------------------------------------------------------------------
-- Whose mistake → admin-only table, then cleared.
insert into mistake_responsibility (mistake_id, staff_id, set_by, set_at)
select m.id, m.staff_id, m.entered_by, m.updated_at
  from job_mistakes m
 where m.staff_id is not null
on conflict (mistake_id) do nothing;

-- Raised by / when; the company cost centre from the line.
update job_mistakes m
   set raised_by = coalesce(m.raised_by, m.entered_by),
       raised_at = coalesce(m.raised_at, m.created_at)
 where m.raised_at is null;

update job_mistakes m
   set cost_centre_id = c.cost_centre_id
  from po_cost_centers c
 where c.id = m.cost_center_id and c.cost_centre_id is not null
   and m.cost_centre_id is distinct from c.cost_centre_id;

-- The office logged them with a cost: they are costed.
update job_mistakes set status = 'costed' where status = 'open' and amount_ex_gst is not null and raised_by is not distinct from entered_by
  and not exists (select 1 from mistake_cost_lines l where l.mistake_id = job_mistakes.id);

-- Each 0115 amount → one legacy manual line.
insert into mistake_cost_lines (mistake_id, kind, source, amount_ex_gst, note, legacy, created_by, created_at, updated_at)
select m.id, 'other', 'manual', m.amount_ex_gst, 'Logged before mistake tracking (0115)', true, m.entered_by, m.created_at, m.updated_at
  from job_mistakes m
 where m.amount_ex_gst is not null
   and not exists (select 1 from mistake_cost_lines l where l.mistake_id = m.id and l.legacy);

-- Now staff_id is in its own table.
update job_mistakes set staff_id = null where staff_id is not null;

alter table job_mistakes alter column raised_at set default now();
alter table job_mistakes alter column raised_by set default auth.uid();

-- ---------------------------------------------------------------------------
-- 5. job_mistakes guard (replaces 0115's body) + the after trigger
-- ---------------------------------------------------------------------------
create or replace function job_mistakes_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_centre uuid;
begin
  if new.job_id is null then
    if new.cost_center_id is not null then
      raise exception 'A mistake with no job can''t name a job''s PO line.' using errcode = 'check_violation';
    end if;
    if new.cost_centre_id is null then
      raise exception 'Pick the company cost centre for a mistake with no job.' using errcode = 'check_violation';
    end if;
  elsif new.cost_center_id is not null then
    select c.cost_centre_id into v_centre
      from po_cost_centers c
      join purchase_orders p on p.id = c.po_id
     where c.id = new.cost_center_id
       and p.job_id = new.job_id;
    if not found then
      raise exception 'That cost centre is not on this job.' using errcode = 'check_violation';
    end if;
    if v_centre is not null then
      new.cost_centre_id := v_centre;
    end if;
  end if;

  if tg_op = 'INSERT' then
    if auth.uid() is not null then
      new.entered_by := auth.uid();
      new.raised_by := auth.uid();
    end if;
    new.created_at := now();
    new.raised_at := coalesce(new.raised_at, now());
    -- A pre-0119 client logs with an amount: that is a costed mistake.
    if new.amount_ex_gst is not null and new.status = 'open' then
      new.status := 'costed';
    end if;
  else
    new.entered_by := old.entered_by;
    new.created_at := old.created_at;
    new.raised_by := old.raised_by;
    new.raised_at := old.raised_at;
  end if;

  if new.status = 'closed' and (tg_op = 'INSERT' or old.status is distinct from 'closed') then
    new.closed_at := now();
  elsif new.status <> 'closed' then
    new.closed_at := null;
  elsif tg_op = 'UPDATE' then
    new.closed_at := old.closed_at;
  end if;

  new.updated_at := now();
  return new;
end;
$$;

revoke all on function job_mistakes_guard() from public, anon, authenticated;

drop trigger if exists job_mistakes_guard on job_mistakes;
create trigger job_mistakes_guard before insert or update on job_mistakes
  for each row execute function job_mistakes_guard();

-- After a write: (a) staff_id → mistake_responsibility (an admin's write only;
-- anyone else's is dropped) and cleared; (b) a pre-0119 client's amount_ex_gst
-- → this mistake's legacy manual line.
create or replace function job_mistakes_after_write()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
begin
  if new.staff_id is not null then
    if v_uid is null or is_admin(v_uid) then
      insert into mistake_responsibility (mistake_id, staff_id, set_by)
      values (new.id, new.staff_id, v_uid)
      on conflict (mistake_id) do update set staff_id = excluded.staff_id, set_by = excluded.set_by, set_at = now();
    end if;
    update job_mistakes set staff_id = null where id = new.id;
  end if;

  if tg_op = 'INSERT' or new.amount_ex_gst is distinct from old.amount_ex_gst then
    if new.amount_ex_gst is null then
      delete from mistake_cost_lines where mistake_id = new.id and legacy;
    else
      insert into mistake_cost_lines (mistake_id, kind, source, amount_ex_gst, note, legacy)
      values (new.id, 'other', 'manual', new.amount_ex_gst, 'Logged before mistake tracking (0115)', true)
      on conflict (mistake_id) where legacy do update set amount_ex_gst = excluded.amount_ex_gst, updated_at = now()
        where mistake_cost_lines.amount_ex_gst is distinct from excluded.amount_ex_gst;
    end if;
  end if;
  return null;
end;
$$;

revoke all on function job_mistakes_after_write() from public, anon, authenticated;

drop trigger if exists job_mistakes_after_write on job_mistakes;
create trigger job_mistakes_after_write after insert or update of staff_id, amount_ex_gst on job_mistakes
  for each row execute function job_mistakes_after_write();

-- ---------------------------------------------------------------------------
-- 6. Cost line guard: a link names a real cost record on the mistake's own
--    job; created_by is the caller; a legacy line keeps job_mistakes.amount_ex_gst
--    in step (for pre-0119 readers).
-- ---------------------------------------------------------------------------
create or replace function mistake_cost_lines_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_job uuid;
  v_src_job uuid;
begin
  if tg_op = 'UPDATE' and (new.mistake_id <> old.mistake_id or new.legacy is distinct from old.legacy) then
    raise exception 'A cost line can''t move to another mistake.' using errcode = 'check_violation';
  end if;

  if new.source <> 'manual' then
    select job_id into v_job from job_mistakes where id = new.mistake_id;
    if v_job is null then
      raise exception 'Only a mistake on a job can link that job''s costs.' using errcode = 'check_violation';
    end if;
    v_src_job := case new.source
      when 'time_entry' then (select job_id from time_entries where id = new.source_id)
      when 'job_expense' then (select job_id from job_expenses where id = new.source_id)
      when 'vendor_order' then (select job_id from vendor_orders where id = new.source_id)
      when 'equipment_usage' then (select job_id from equipment_usage_log where id = new.source_id)
      when 'hire_entry' then (select job_id from hire_entries where id = new.source_id)
    end;
    if v_src_job is distinct from v_job then
      raise exception 'That cost isn''t on this mistake''s job.' using errcode = 'check_violation';
    end if;
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
  new.updated_at := now();
  return new;
end;
$$;

revoke all on function mistake_cost_lines_guard() from public, anon, authenticated;

drop trigger if exists mistake_cost_lines_guard on mistake_cost_lines;
create trigger mistake_cost_lines_guard before insert or update on mistake_cost_lines
  for each row execute function mistake_cost_lines_guard();

create or replace function mistake_cost_lines_legacy_sync()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'DELETE' then
    if old.legacy then
      update job_mistakes set amount_ex_gst = null where id = old.mistake_id and amount_ex_gst is not null;
    end if;
    return null;
  end if;
  if new.legacy then
    update job_mistakes set amount_ex_gst = new.amount_ex_gst
     where id = new.mistake_id and amount_ex_gst is distinct from new.amount_ex_gst;
  end if;
  return null;
end;
$$;

revoke all on function mistake_cost_lines_legacy_sync() from public, anon, authenticated;

drop trigger if exists mistake_cost_lines_legacy_sync on mistake_cost_lines;
create trigger mistake_cost_lines_legacy_sync after insert or update or delete on mistake_cost_lines
  for each row execute function mistake_cost_lines_legacy_sync();

-- A deleted cost record takes its links with it.
create or replace function mistake_links_follow_delete()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  delete from mistake_cost_lines where source = tg_argv[0] and source_id = old.id;
  return null;
end;
$$;

revoke all on function mistake_links_follow_delete() from public, anon, authenticated;

drop trigger if exists mistake_links_follow_delete on time_entries;
create trigger mistake_links_follow_delete after delete on time_entries
  for each row execute function mistake_links_follow_delete('time_entry');
drop trigger if exists mistake_links_follow_delete on job_expenses;
create trigger mistake_links_follow_delete after delete on job_expenses
  for each row execute function mistake_links_follow_delete('job_expense');
drop trigger if exists mistake_links_follow_delete on vendor_orders;
create trigger mistake_links_follow_delete after delete on vendor_orders
  for each row execute function mistake_links_follow_delete('vendor_order');
drop trigger if exists mistake_links_follow_delete on equipment_usage_log;
create trigger mistake_links_follow_delete after delete on equipment_usage_log
  for each row execute function mistake_links_follow_delete('equipment_usage');
drop trigger if exists mistake_links_follow_delete on hire_entries;
create trigger mistake_links_follow_delete after delete on hire_entries
  for each row execute function mistake_links_follow_delete('hire_entry');

-- ---------------------------------------------------------------------------
-- 7. The crew's door (and its read)
-- ---------------------------------------------------------------------------
create or replace function raise_job_mistake(
  p_id uuid,
  p_job_id uuid,
  p_cost_center_id uuid,
  p_category_id uuid,
  p_cause_code text,
  p_description text,
  p_occurred_on date,
  p_time_entry_ids uuid[]
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_active boolean;
  v_row record;
  v_today date := (now() at time zone 'Australia/Melbourne')::date;
  v_entry uuid;
  v_n int;
begin
  if v_uid is null or p_id is null or p_job_id is null or p_category_id is null then
    raise exception 'Missing details to log the mistake.' using errcode = 'MJ120';
  end if;
  select coalesce(is_active, true) into v_active from profiles where id = v_uid;
  if not found or not v_active then
    raise exception 'Your account can''t log mistakes.' using errcode = 'MJ121';
  end if;
  if not exists (select 1 from jobs where id = p_job_id) then
    raise exception 'Job not found.' using errcode = 'MJ122';
  end if;
  if not user_can_manage_job(p_job_id::text) then
    raise exception 'This job isn''t one of yours.' using errcode = 'MJ123';
  end if;

  -- A retry of the same request: answer with what was made.
  select id, job_id, raised_by into v_row from job_mistakes where id = p_id;
  if found then
    if v_row.raised_by is distinct from v_uid or v_row.job_id is distinct from p_job_id then
      raise exception 'That mistake isn''t yours.' using errcode = 'MJ124';
    end if;
    return p_id;
  end if;

  if not exists (select 1 from mistake_categories where id = p_category_id and is_active) then
    raise exception 'Pick a category.' using errcode = 'MJ125';
  end if;
  if p_cause_code is not null and p_cause_code not in
     ('quoting', 'ordering', 'supplier', 'install', 'communication_handover', 'plans_builder_change', 'site_conditions', 'other') then
    raise exception 'Pick a cause from the list.' using errcode = 'MJ126';
  end if;
  if p_description is null or char_length(btrim(p_description)) not between 1 and 2000 then
    raise exception 'Say what went wrong (up to 2000 characters).' using errcode = 'MJ127';
  end if;
  if p_occurred_on is not null and p_occurred_on > v_today then
    raise exception 'The date can''t be in the future.' using errcode = 'MJ128';
  end if;
  if p_cost_center_id is not null and not exists (
    select 1 from po_cost_centers c join purchase_orders p on p.id = c.po_id
     where c.id = p_cost_center_id and p.job_id = p_job_id
  ) then
    raise exception 'Pick one of this job''s cost centres.' using errcode = 'MJ129';
  end if;

  -- Rework time: only the caller's own WORK entries on this job, not already
  -- part of another mistake.
  if p_time_entry_ids is not null and cardinality(p_time_entry_ids) > 0 then
    if cardinality(p_time_entry_ids) > 50 then
      raise exception 'Tick fewer time entries.' using errcode = 'MJ130';
    end if;
    select count(*) into v_n
      from time_entries t
     where t.id = any (p_time_entry_ids)
       and t.staff_id = v_uid and t.job_id = p_job_id and t.entry_type = 'work';
    if v_n <> (select count(distinct x) from unnest(p_time_entry_ids) x) then
      raise exception 'You can only mark your own time on this job as rework.' using errcode = 'MJ130';
    end if;
    if exists (select 1 from mistake_cost_lines where source = 'time_entry' and source_id = any (p_time_entry_ids)) then
      raise exception 'Some of that time is already part of another mistake.' using errcode = 'MJ131';
    end if;
  end if;

  insert into job_mistakes (id, job_id, cost_center_id, category_id, cause_code, description, occurred_on, status, raised_by, entered_by)
  values (p_id, p_job_id, p_cost_center_id, p_category_id, p_cause_code, btrim(p_description),
          coalesce(p_occurred_on, v_today), 'open', v_uid, v_uid);

  if p_time_entry_ids is not null and cardinality(p_time_entry_ids) > 0 then
    foreach v_entry in array (select array_agg(distinct x) from unnest(p_time_entry_ids) x) loop
      insert into mistake_cost_lines (mistake_id, kind, source, source_id, note)
      values (p_id, 'labour', 'time_entry', v_entry, 'Rework time marked by the crew');
    end loop;
  end if;

  return p_id;
end;
$$;

comment on function raise_job_mistake(uuid, uuid, uuid, uuid, text, text, date, uuid[]) is
  'Log a mistake on a job you''re on (or any job, office/admin) — the crew''s only write to job_mistakes (0119). Never takes or returns money.';

create or replace function my_job_mistakes(p_job_id uuid)
returns table (
  id uuid,
  job_id uuid,
  occurred_on date,
  category_name text,
  cause_code text,
  description text,
  status text,
  stage_id uuid,
  stage_name text,
  raised_at timestamptz,
  photo_count int,
  rework_entry_ids uuid[]
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select m.id, m.job_id, m.occurred_on, c.name, m.cause_code, m.description, m.status,
         m.cost_center_id, pcc.name, m.raised_at,
         (select count(*)::int from mistake_photos ph where ph.mistake_id = m.id),
         coalesce((select array_agg(l.source_id order by l.created_at) from mistake_cost_lines l
                    join time_entries t on t.id = l.source_id and t.staff_id = auth.uid()
                   where l.mistake_id = m.id and l.source = 'time_entry'), '{}')
    from job_mistakes m
    left join mistake_categories c on c.id = m.category_id
    left join po_cost_centers pcc on pcc.id = m.cost_center_id
   where m.job_id = p_job_id
     and m.raised_by = auth.uid()
     and auth.uid() is not null
   order by m.occurred_on desc, m.raised_at desc;
$$;

comment on function my_job_mistakes(uuid) is
  'The mistakes the caller raised on a job — money-free columns only (0119).';

create or replace function add_job_mistake_photo(p_mistake_id uuid, p_path text)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_m record;
  v_id uuid;
begin
  if v_uid is null or p_mistake_id is null or p_path is null then
    raise exception 'Missing details for the photo.' using errcode = 'MJ120';
  end if;
  select id, job_id, raised_by into v_m from job_mistakes where id = p_mistake_id;
  if not found or v_m.job_id is null then
    raise exception 'Mistake not found.' using errcode = 'MJ132';
  end if;
  if v_m.raised_by is distinct from v_uid and not is_office_or_admin(v_uid) then
    raise exception 'Only whoever logged the mistake, or the office, can add photos.' using errcode = 'MJ124';
  end if;
  if p_path !~ ('^' || v_m.job_id::text || '/mistakes/' || v_m.id::text || '/[A-Za-z0-9._-]{1,120}$') then
    raise exception 'That photo isn''t stored with this mistake.' using errcode = 'MJ133';
  end if;
  select id into v_id from mistake_photos where storage_path = p_path;
  if found then
    return v_id;
  end if;
  if (select count(*) from mistake_photos where mistake_id = p_mistake_id) >= 8 then
    raise exception 'A mistake can have up to 8 photos.' using errcode = 'MJ134';
  end if;
  insert into mistake_photos (mistake_id, storage_path, created_by) values (p_mistake_id, p_path, v_uid)
  returning id into v_id;
  return v_id;
end;
$$;

revoke execute on function raise_job_mistake(uuid, uuid, uuid, uuid, text, text, date, uuid[]) from public, anon;
revoke execute on function my_job_mistakes(uuid) from public, anon;
revoke execute on function add_job_mistake_photo(uuid, text) from public, anon;
grant execute on function raise_job_mistake(uuid, uuid, uuid, uuid, text, text, date, uuid[]) to authenticated, service_role;
grant execute on function my_job_mistakes(uuid) to authenticated, service_role;
grant execute on function add_job_mistake_photo(uuid, text) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 8. RLS — every table's policies cleared by enumeration first (HANDOVER §4).
--    job_mistakes keeps 0115's one office/admin policy, re-created as is.
-- ---------------------------------------------------------------------------
do $$
declare
  t text;
  p record;
begin
  foreach t in array array['job_mistakes', 'mistake_categories', 'mistake_cost_lines', 'mistake_photos', 'mistake_responsibility'] loop
    for p in select polname from pg_policy where polrelid = ('public.' || t)::regclass loop
      execute format('drop policy %I on %I', p.polname, t);
    end loop;
    execute format('alter table %I enable row level security', t);
  end loop;
end $$;

create policy "job mistakes: office/admin manage" on job_mistakes for all
  to authenticated
  using ((select is_office_or_admin(auth.uid())))
  with check ((select is_office_or_admin(auth.uid())));

create policy "mistake categories: everyone signed in reads" on mistake_categories for select
  to authenticated
  using (true);
create policy "mistake categories: office/admin add" on mistake_categories for insert
  to authenticated
  with check ((select is_office_or_admin(auth.uid())));
create policy "mistake categories: office/admin edit" on mistake_categories for update
  to authenticated
  using ((select is_office_or_admin(auth.uid())))
  with check ((select is_office_or_admin(auth.uid())));
create policy "mistake categories: office/admin delete" on mistake_categories for delete
  to authenticated
  using ((select is_office_or_admin(auth.uid())));

create policy "mistake cost lines: office/admin manage" on mistake_cost_lines for all
  to authenticated
  using ((select is_office_or_admin(auth.uid())))
  with check ((select is_office_or_admin(auth.uid())));

create policy "mistake photos: office/admin manage" on mistake_photos for all
  to authenticated
  using ((select is_office_or_admin(auth.uid())))
  with check ((select is_office_or_admin(auth.uid())));

create policy "mistake responsibility: admin only" on mistake_responsibility for all
  to authenticated
  using ((select is_admin(auth.uid())))
  with check ((select is_admin(auth.uid())));

-- ---------------------------------------------------------------------------
-- 9. Grants (0088: this project does not expose new tables by itself)
-- ---------------------------------------------------------------------------
grant select, insert, update, delete on job_mistakes, mistake_categories, mistake_cost_lines, mistake_photos, mistake_responsibility to authenticated;
grant all on job_mistakes, mistake_categories, mistake_cost_lines, mistake_photos, mistake_responsibility to service_role;
revoke all on job_mistakes, mistake_categories, mistake_cost_lines, mistake_photos, mistake_responsibility from anon;

-- ---------------------------------------------------------------------------
-- 10. Assert the end state
-- ---------------------------------------------------------------------------
do $$
declare
  t text;
  n int;
  p record;
  money_re text := '(rate|cost|price|amount|total|sell|margin|markup|hourly|salary|wage|charge'
                || '|fee|value|balance|paid|owing|gst|deposit|discount|surcharge|levy'
                || '|insurance|maintenance|registration|annual|subtotal|invoice_total)';
begin
  foreach t in array array['job_mistakes', 'mistake_categories', 'mistake_cost_lines', 'mistake_photos', 'mistake_responsibility'] loop
    if not (select relrowsecurity from pg_class where oid = ('public.' || t)::regclass) then
      raise exception '0119: RLS is off on %', t;
    end if;
    if has_table_privilege('anon', 'public.' || t, 'SELECT') then
      raise exception '0119: anon can read %', t;
    end if;
    if not (has_table_privilege('authenticated', 'public.' || t, 'SELECT')
        and has_table_privilege('authenticated', 'public.' || t, 'INSERT')
        and has_table_privilege('authenticated', 'public.' || t, 'UPDATE')
        and has_table_privilege('authenticated', 'public.' || t, 'DELETE')) then
      raise exception '0119: authenticated lacks a table privilege on %', t;
    end if;
    if not has_table_privilege('service_role', 'public.' || t, 'SELECT') then
      raise exception '0119: service_role cannot read %', t;
    end if;
    if exists (select 1 from pg_publication_tables where pubname = 'powersync' and schemaname = 'public' and tablename = t) then
      raise exception '0119: % is in the powersync publication — it must not reach devices', t;
    end if;
  end loop;

  -- The money tables: exactly one FOR ALL office/admin policy (admin for responsibility).
  foreach t in array array['job_mistakes', 'mistake_cost_lines', 'mistake_photos'] loop
    select count(*) into n from pg_policy where polrelid = ('public.' || t)::regclass;
    if n <> 1 then raise exception '0119: expected exactly 1 policy on %, found %', t, n; end if;
    select polcmd, polpermissive, pg_get_expr(polqual, polrelid) as q, pg_get_expr(polwithcheck, polrelid) as w
      into p from pg_policy where polrelid = ('public.' || t)::regclass;
    if p.polcmd <> '*' or not p.polpermissive
       or position('is_office_or_admin' in coalesce(p.q, '')) = 0 or position('is_office_or_admin' in coalesce(p.w, '')) = 0 then
      raise exception '0119: the % policy is not FOR ALL office/admin (USING and WITH CHECK)', t;
    end if;
  end loop;

  select count(*) into n from pg_policy where polrelid = 'public.mistake_responsibility'::regclass;
  if n <> 1 then raise exception '0119: expected exactly 1 policy on mistake_responsibility, found %', n; end if;
  select polcmd, pg_get_expr(polqual, polrelid) as q, pg_get_expr(polwithcheck, polrelid) as w
    into p from pg_policy where polrelid = 'public.mistake_responsibility'::regclass;
  if p.polcmd <> '*' or position('is_admin(' in coalesce(p.q, '')) = 0 or position('is_admin(' in coalesce(p.w, '')) = 0
     or position('office' in coalesce(p.q, '') || coalesce(p.w, '')) > 0 then
    raise exception '0119: mistake_responsibility is not admin only';
  end if;

  -- Categories: anyone reads, only office/admin write.
  select count(*) into n from pg_policy
   where polrelid = 'public.mistake_categories'::regclass and polcmd in ('a', 'w', 'd', '*')
     and position('is_office_or_admin' in coalesce(pg_get_expr(polqual, polrelid), '') || coalesce(pg_get_expr(polwithcheck, polrelid), '')) = 0;
  if n > 0 then raise exception '0119: a mistake_categories write policy is not office/admin'; end if;
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'mistake_categories' and column_name ~* money_re) then
    raise exception '0119: mistake_categories carries a money-named column';
  end if;
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'mistake_photos' and column_name ~* money_re) then
    raise exception '0119: mistake_photos carries a money-named column';
  end if;

  -- The sweep must pick the money up.
  foreach t in array array['amount_ex_gst', 'recovery_claimed_ex_gst', 'recovered_ex_gst'] loop
    if t !~* money_re then raise exception '0119: % is not money-named for the sweep', t; end if;
  end loop;

  -- The crew's functions: definer, authenticated yes, anon no; and they hand out no money.
  foreach t in array array['public.raise_job_mistake(uuid, uuid, uuid, uuid, text, text, date, uuid[])',
                           'public.my_job_mistakes(uuid)', 'public.add_job_mistake_photo(uuid, text)'] loop
    if not (select prosecdef from pg_proc where oid = t::regprocedure) then
      raise exception '0119: % is not SECURITY DEFINER', t;
    end if;
    if has_function_privilege('anon', t, 'execute') then raise exception '0119: anon can run %', t; end if;
    if not has_function_privilege('authenticated', t, 'execute') then raise exception '0119: authenticated cannot run %', t; end if;
  end loop;
  if exists (select 1 from unnest((select proargnames from pg_proc where oid = 'public.my_job_mistakes(uuid)'::regprocedure)) a
              where a ~* money_re and a <> 'p_job_id') then
    raise exception '0119: my_job_mistakes returns a money-named column';
  end if;
  if (select prorettype from pg_proc where oid = 'public.raise_job_mistake(uuid, uuid, uuid, uuid, text, text, date, uuid[])'::regprocedure) <> 'uuid'::regtype then
    raise exception '0119: raise_job_mistake must return only the id';
  end if;
  foreach t in array array['job_mistakes_guard()', 'job_mistakes_after_write()', 'mistake_cost_lines_guard()',
                           'mistake_cost_lines_legacy_sync()', 'mistake_links_follow_delete()'] loop
    if has_function_privilege('authenticated', 'public.' || t, 'execute') then
      raise exception '0119: authenticated can run %', t;
    end if;
  end loop;

  -- Triggers in place.
  if (select count(*) from pg_trigger where not tgisinternal and tgenabled <> 'D' and tgname in
        ('job_mistakes_guard', 'job_mistakes_after_write', 'mistake_cost_lines_guard', 'mistake_cost_lines_legacy_sync')) <> 4 then
    raise exception '0119: a mistake trigger is missing or disabled';
  end if;
  if (select count(*) from pg_trigger where not tgisinternal and tgenabled <> 'D' and tgname = 'mistake_links_follow_delete') <> 5 then
    raise exception '0119: a mistake_links_follow_delete trigger is missing or disabled';
  end if;

  -- Carried over: no 0115 amount without its legacy line, no staff_id left.
  if exists (select 1 from job_mistakes m where m.amount_ex_gst is not null
              and not exists (select 1 from mistake_cost_lines l where l.mistake_id = m.id and l.legacy and l.amount_ex_gst = m.amount_ex_gst)) then
    raise exception '0119: a 0115 amount has no matching legacy cost line';
  end if;
  if exists (select 1 from job_mistakes where staff_id is not null) then
    raise exception '0119: job_mistakes.staff_id still holds whose-mistake data';
  end if;
  if (select count(*) from mistake_categories) < 10 then
    raise exception '0119: the mistake categories were not seeded';
  end if;
end $$;

notify pgrst, 'reload schema';

select '0119 APPLIED — now run supabase/tests/0119_mistake_tracking_test.sql' as result;
