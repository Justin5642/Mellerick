-- =============================================
-- CATCH-UP: what 0064 and 0065 were meant to do, on today's database
-- STATUS: DRAFT — not applied.
--
-- WHY
-- A read-only check on 24 Nov 2026 found 0064, 0065, 0066, 0067 and 0070
-- missing from production, although their headers (and HANDOVER) said
-- "applied 2026-10-08/09". 0066, 0067 and 0070 can still run as written.
-- 0064 and 0065 cannot: each drops EVERY policy on its table and then asserts
-- there are no restrictive ones — but 0074 (job_documents) and 0110 (sites,
-- job_documents) have since added restrictive policies. Run as written they
-- would fail (and roll back); worse, a version without the assertion would
-- silently delete those later rules.
--
-- WHAT (same intent as 0064 / 0065)
--   sites          permissive policies replaced: read + add for every
--                  signed-in user; update + delete office/admin only.
--   job_documents  office_only column; permissive policies replaced so a
--                  technician never sees or changes an office-only row.
--   storage        storage_object_is_money_document() also hides office-only
--                  documents' files and the phone's '<job>/expense-<id>' path.
-- Only PERMISSIVE policies are dropped (by enumeration, never by name); every
-- RESTRICTIVE policy is left exactly as it was, and that is asserted.
-- Calls are written wrapped ((select …)), the form 0069 leaves behind.
--
-- Idempotent. On a database where 0064/0065 already ran (CI) it ends in the
-- same rules.
-- =============================================

alter table job_documents add column if not exists office_only boolean not null default false;
create index if not exists job_documents_storage_path_idx on job_documents (storage_path);

alter table sites enable row level security;
alter table job_documents enable row level security;

drop table if exists pg_temp.m0117_restrictive;
create temp table m0117_restrictive as
  select polrelid::regclass::text as tbl, polname, polcmd,
         coalesce(pg_get_expr(polqual, polrelid), '') || '|' ||
         coalesce(pg_get_expr(polwithcheck, polrelid), '') as body
    from pg_policy
   where polrelid in ('public.sites'::regclass, 'public.job_documents'::regclass)
     and not polpermissive;

do $$
declare
  pol record;
begin
  for pol in
    select polrelid::regclass::text as tbl, polname
      from pg_policy
     where polrelid in ('public.sites'::regclass, 'public.job_documents'::regclass)
       and polpermissive
  loop
    execute format('drop policy %I on %s', pol.polname, pol.tbl);
  end loop;
end $$;

-- sites (0064)
create policy "Authenticated users can read sites" on sites for select
  using ((select auth.role()) = 'authenticated');

create policy "Authenticated users can add sites" on sites for insert
  with check ((select auth.role()) = 'authenticated');

create policy "Office/admin can update sites" on sites for update
  using ((select is_office_or_admin(auth.uid())))
  with check ((select is_office_or_admin(auth.uid())));

create policy "Office/admin can delete sites" on sites for delete
  using ((select is_office_or_admin(auth.uid())));

-- job_documents (0065)
create policy "Job documents readable; office-only ones office/admin" on job_documents for select
  using ((select auth.role()) = 'authenticated' and (not office_only or (select is_office_or_admin(auth.uid()))));

create policy "Job documents insertable; office-only ones office/admin" on job_documents for insert
  with check ((select auth.role()) = 'authenticated' and (not office_only or (select is_office_or_admin(auth.uid()))));

create policy "Job documents updatable; office-only ones office/admin" on job_documents for update
  using ((select auth.role()) = 'authenticated' and (not office_only or (select is_office_or_admin(auth.uid()))))
  with check ((select auth.role()) = 'authenticated' and (not office_only or (select is_office_or_admin(auth.uid()))));

create policy "Job documents deletable; office-only ones office/admin" on job_documents for delete
  using ((select auth.role()) = 'authenticated' and (not office_only or (select is_office_or_admin(auth.uid()))));

-- storage (0065): the bucket policies from 0047 call this by name.
create or replace function storage_object_is_money_document(object_name text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select object_name like '%/expense-receipt-%'
      or object_name like '%/expense-%'
      or object_name like '%/variations/%'
      or exists (
        select 1 from job_documents d
         where d.storage_path = object_name and d.office_only
      );
$$;

-- Post-conditions
do $$
declare
  n int;
  bad text;
begin
  -- Every restrictive policy that was there is still there, unchanged.
  select count(*) into n from (
    (select tbl, polname, polcmd, body from m0117_restrictive
     except
     select polrelid::regclass::text, polname, polcmd,
            coalesce(pg_get_expr(polqual, polrelid), '') || '|' ||
            coalesce(pg_get_expr(polwithcheck, polrelid), '')
       from pg_policy
      where polrelid in ('public.sites'::regclass, 'public.job_documents'::regclass)
        and not polpermissive)
  ) x;
  if n <> 0 then
    raise exception '0117: % restrictive policies were changed or removed', n;
  end if;

  if not (select relrowsecurity from pg_class where oid = 'public.sites'::regclass)
     or not (select relrowsecurity from pg_class where oid = 'public.job_documents'::regclass) then
    raise exception '0117: row level security is off on sites or job_documents';
  end if;

  -- sites: exactly four permissive policies; the two write ones office/admin only.
  if (select count(*) from pg_policy where polrelid = 'public.sites'::regclass and polpermissive) <> 4 then
    raise exception '0117: sites does not have exactly 4 permissive policies';
  end if;
  select string_agg(polname, ', ') into bad
    from pg_policy
   where polrelid = 'public.sites'::regclass and polpermissive and polcmd in ('w', 'd')
     and (position('is_office_or_admin' in coalesce(pg_get_expr(polqual, polrelid), '')) = 0
          or position(' OR ' in upper(coalesce(pg_get_expr(polqual, polrelid), ''))) > 0
          or (polcmd = 'w' and position('is_office_or_admin' in coalesce(pg_get_expr(polwithcheck, polrelid), '')) = 0));
  if bad is not null then
    raise exception '0117: sites write policies not gated on office/admin: %', bad;
  end if;
  if (select count(*) from pg_policy
       where polrelid = 'public.sites'::regclass and polpermissive and polcmd in ('w', 'd')) <> 2
     or exists (select 1 from pg_policy
                 where polrelid = 'public.sites'::regclass and polpermissive and polcmd = '*') then
    raise exception '0117: sites must have one UPDATE, one DELETE and no FOR ALL permissive policy';
  end if;

  -- job_documents: four permissive policies, each carrying the office_only gate.
  if (select count(*) from pg_policy where polrelid = 'public.job_documents'::regclass and polpermissive) <> 4 then
    raise exception '0117: job_documents does not have exactly 4 permissive policies';
  end if;
  select string_agg(polname, ', ') into bad
    from pg_policy
   where polrelid = 'public.job_documents'::regclass and polpermissive
     and ((polqual is not null and position('office_only' in pg_get_expr(polqual, polrelid)) = 0)
          or (polwithcheck is not null and position('office_only' in pg_get_expr(polwithcheck, polrelid)) = 0));
  if bad is not null then
    raise exception '0117: job_documents policies missing the office_only gate: %', bad;
  end if;

  if not storage_object_is_money_document('j1/expense-receipt-1_a.pdf')
     or not storage_object_is_money_document('j1/expense-abc.jpg')
     or not storage_object_is_money_document('j1/variations/1_q.pdf')
     or not storage_object_is_money_document('j1/expense-receipt-cartage-x-1.jpg')
     or storage_object_is_money_document('j1/1700000000_plans.pdf') then
    raise exception '0117: storage_object_is_money_document classifies paths wrongly';
  end if;
end $$;

drop table if exists pg_temp.m0117_restrictive;
