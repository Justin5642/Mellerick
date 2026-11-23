-- ============================================================================
-- Mistake costs on a job, per cost centre (office/admin only).
--
-- STATUS: DRAFT — NOT APPLIED. Justin pastes it into the Supabase SQL editor,
-- then the gate test supabase/tests/0115_job_mistakes_test.sql, and trusts
-- only the final "0115 PASSED" row. Then change this line to applied and add
-- the ledger row:
--   insert into supabase_migrations.schema_migrations (version,name)
--   values ('0115','job_mistakes') on conflict do nothing;
-- Safe to merge the app before this is applied: every reader treats a missing
-- table (42P01 / PGRST205) or column (42703 / PGRST204) as "no mistakes", and
-- the Mistakes card and report say they aren't switched on yet.
--
-- WHY (Justin, 23 Nov 2026): "We also need a way of tracking the expense of
-- mistakes in each cost centre that will be a negative cost." He chose: the
-- office logs them, and they reduce the job's margin, shown as their own line
-- in the Job Ledger (lib/job-ledger.ts) and Job Margins.
--
--   job_mistakes  one row per mistake on a job: the job's PO line it belongs
--                 to (po_cost_centers — null = "Not tagged"), the day, the
--                 cost ex GST, what happened, an optional cause and whose
--                 mistake it was. OFFICE/ADMIN ONLY for every operation; a
--                 technician reads and writes nothing.
--
-- The cost centre must be one of THIS job's PO lines (trigger
-- job_mistakes_guard): a line on another job's PO is refused.
--
-- MONEY: amount_ex_gst matches the money sweep's regex (asserted), and
-- supabase/ci/seed-roles.sql seeds one row so the sweep checks real data.
-- PowerSync: in NO stream and not in the powersync publication (asserted) —
-- sync-streams.yaml is untouched, so no redeploy.
-- ============================================================================

create table if not exists job_mistakes (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references jobs(id) on delete cascade,
  cost_center_id uuid references po_cost_centers(id) on delete set null,
  occurred_on date not null default ((now() at time zone 'Australia/Melbourne')::date),
  amount_ex_gst numeric(12,2) not null,
  description text not null,
  cause text,
  staff_id uuid references profiles(id) on delete set null,
  entered_by uuid references profiles(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Checks by name, re-runnable.
do $$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.job_mistakes'::regclass and conname = 'job_mistakes_amount_positive') then
    alter table job_mistakes add constraint job_mistakes_amount_positive check (amount_ex_gst > 0);
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.job_mistakes'::regclass and conname = 'job_mistakes_description_length') then
    alter table job_mistakes add constraint job_mistakes_description_length
      check (char_length(btrim(description)) between 1 and 2000);
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.job_mistakes'::regclass and conname = 'job_mistakes_cause_length') then
    alter table job_mistakes add constraint job_mistakes_cause_length
      check (cause is null or char_length(cause) <= 500);
  end if;
end $$;

create index if not exists job_mistakes_job_id_idx on job_mistakes (job_id);
create index if not exists job_mistakes_occurred_on_idx on job_mistakes (occurred_on);
create index if not exists job_mistakes_cost_center_id_idx on job_mistakes (cost_center_id);

comment on table job_mistakes is
  'Mistake costs on a job (0115): one row per mistake, against one of the job''s PO lines (null = not tagged). A cost that reduces the job''s margin, shown as its own line in the Job Ledger. Office/admin only.';
comment on column job_mistakes.amount_ex_gst is 'What the mistake cost, ex GST (> 0). Counted as cost in the Job Ledger.';
comment on column job_mistakes.cost_center_id is 'The job''s PO line (po_cost_centers) — must belong to a PO on the same job. Null = not tagged.';
comment on column job_mistakes.staff_id is 'Whose mistake it was (optional).';

-- ---------------------------------------------------------------------------
-- Guard: the cost centre is this job's; entered_by is the caller and never
-- changes; updated_at is the database clock.
-- ---------------------------------------------------------------------------
create or replace function job_mistakes_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.cost_center_id is not null and not exists (
    select 1
      from po_cost_centers c
      join purchase_orders p on p.id = c.po_id
     where c.id = new.cost_center_id
       and p.job_id = new.job_id
  ) then
    raise exception 'That cost centre is not on this job.' using errcode = 'check_violation';
  end if;

  if tg_op = 'INSERT' then
    if auth.uid() is not null then
      new.entered_by := auth.uid();
    end if;
    new.created_at := now();
  else
    new.entered_by := old.entered_by;
    new.created_at := old.created_at;
  end if;
  new.updated_at := now();
  return new;
end;
$$;

revoke all on function job_mistakes_guard() from public, anon, authenticated;

drop trigger if exists job_mistakes_guard on job_mistakes;
create trigger job_mistakes_guard before insert or update on job_mistakes
  for each row execute function job_mistakes_guard();

-- ---------------------------------------------------------------------------
-- RLS — re-runnable: clear this table's policies by enumeration first
-- (HANDOVER §4 — never by guessed name).
-- ---------------------------------------------------------------------------
do $$
declare p record;
begin
  for p in select polname from pg_policy where polrelid = 'public.job_mistakes'::regclass
  loop
    execute format('drop policy %I on job_mistakes', p.polname);
  end loop;
end $$;

alter table job_mistakes enable row level security;
create policy "job mistakes: office/admin manage" on job_mistakes for all
  to authenticated
  using ((select is_office_or_admin(auth.uid())))
  with check ((select is_office_or_admin(auth.uid())));

-- ---------------------------------------------------------------------------
-- Grants (0088: this project does not expose new tables by itself).
-- ---------------------------------------------------------------------------
grant select, insert, update, delete on job_mistakes to authenticated;
grant all on job_mistakes to service_role;
revoke all on job_mistakes from anon;

-- ---------------------------------------------------------------------------
-- Assert the end state (a paste that silently did nothing must fail loudly).
-- ---------------------------------------------------------------------------
do $$
declare
  n int;
  p record;
begin
  if not (select relrowsecurity from pg_class where oid = 'public.job_mistakes'::regclass) then
    raise exception '0115: RLS is off on job_mistakes';
  end if;

  select count(*) into n from pg_policy where polrelid = 'public.job_mistakes'::regclass;
  if n <> 1 then raise exception '0115: expected exactly 1 policy on job_mistakes, found %', n; end if;

  select polcmd, polroles, pg_get_expr(polqual, polrelid) as q, pg_get_expr(polwithcheck, polrelid) as w
    into p from pg_policy where polrelid = 'public.job_mistakes'::regclass;
  if p.polcmd <> '*' then raise exception '0115: the job_mistakes policy is not FOR ALL'; end if;
  if p.polroles <> array['authenticated'::regrole]::oid[] then
    raise exception '0115: the job_mistakes policy is not TO authenticated only';
  end if;
  if position('is_office_or_admin' in coalesce(p.q, '')) = 0 or position('is_office_or_admin' in coalesce(p.w, '')) = 0 then
    raise exception '0115: the job_mistakes policy is not office/admin only (USING and WITH CHECK)';
  end if;

  if not (has_table_privilege('authenticated', 'public.job_mistakes', 'SELECT')
      and has_table_privilege('authenticated', 'public.job_mistakes', 'INSERT')
      and has_table_privilege('authenticated', 'public.job_mistakes', 'UPDATE')
      and has_table_privilege('authenticated', 'public.job_mistakes', 'DELETE')) then
    raise exception '0115: authenticated lacks a table privilege on job_mistakes';
  end if;
  if not has_table_privilege('service_role', 'public.job_mistakes', 'SELECT') then
    raise exception '0115: service_role cannot read job_mistakes';
  end if;
  if has_table_privilege('anon', 'public.job_mistakes', 'SELECT') then
    raise exception '0115: anon can read job_mistakes';
  end if;

  if not exists (select 1 from pg_trigger where tgrelid = 'public.job_mistakes'::regclass and tgname = 'job_mistakes_guard' and not tgisinternal) then
    raise exception '0115: job_mistakes_guard trigger missing';
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.job_mistakes'::regclass and conname = 'job_mistakes_amount_positive') then
    raise exception '0115: the amount check is missing';
  end if;

  -- The money sweep (money_boundary_sweep.sql) must pick the amount up.
  if 'amount_ex_gst' !~* ('(rate|cost|price|amount|total|sell|margin|markup|hourly|salary|wage|charge'
                       || '|fee|value|balance|paid|owing|gst|deposit|discount|surcharge|levy'
                       || '|insurance|maintenance|registration|annual|subtotal|invoice_total)') then
    raise exception '0115: amount_ex_gst is not money-named for the sweep';
  end if;

  -- Never replicated to devices.
  if exists (select 1 from pg_publication_tables where pubname = 'powersync' and tablename = 'job_mistakes' and schemaname = 'public') then
    raise exception '0115: job_mistakes is in the powersync publication — it must not reach devices';
  end if;
end $$;

notify pgrst, 'reload schema';
