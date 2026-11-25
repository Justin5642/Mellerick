-- =============================================
-- CATCH-UP: what 0064, 0065 and 0066 were meant to do, on today's database
-- STATUS: ✅ APPLIED IN PRODUCTION (2026-11-24, catch-up paste returned CATCH-UP PASSED; confirmed by a read-only check).
--
-- WHY
-- A read-only check on 24 Nov 2026 found 0064, 0065, 0066, 0067 and 0070
-- missing from production, although their headers (and HANDOVER) said
-- "applied 2026-10-08/09". 0067 and 0070 can still run as written.
-- 0066 failed in the Supabase SQL editor (24 Nov 2026: relation
-- "m0066_other_storage_policies" does not exist): its temp table did not
-- survive from one statement to the next there, so this file keeps every
-- before/after snapshot inside ONE DO block and uses no temp table.
-- 0064 and 0065 cannot run as written either: each drops EVERY policy on its table and then asserts
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
--   backflow-certificates (0066) the bucket's policies replaced: signatures
--                  only, under an existing device; uploader reads/replaces
--                  their own; office/admin read and delete all.
-- Only PERMISSIVE policies are dropped on sites/job_documents (by
-- enumeration, never by name); every RESTRICTIVE policy is left exactly as it
-- was, and every storage policy outside backflow-certificates too — asserted.
-- Calls are written wrapped ((select …)), the form 0069 leaves behind.
--
-- Idempotent. On a database where 0064/0065/0066 already ran (CI) it ends in
-- the same rules.
-- =============================================

alter table job_documents add column if not exists office_only boolean not null default false;
create index if not exists job_documents_storage_path_idx on job_documents (storage_path);

alter table sites enable row level security;
alter table job_documents enable row level security;

-- storage (0065): the job-documents bucket policies from 0047 call this by name.
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

-- backflow-certificates (0066)
create or replace function storage_object_is_backflow_signature(object_name text)
returns boolean
language sql
stable
set search_path = public
as $$
  select split_part(object_name, '/', 2) = 'signatures'
     and split_part(object_name, '/', 3) <> ''
     and split_part(object_name, '/', 4) = ''
     and exists (
       select 1 from public.backflow_devices d
       where d.id::text = split_part(object_name, '/', 1)
     );
$$;

comment on function storage_object_is_backflow_signature(text) is
  'True when a backflow-certificates object key is <existing device id>/signatures/<file>. '
  'The only path a client may write in that bucket (migrations 0066/0117); certificate PDFs '
  'are written by the service-role submit route.';

revoke execute on function storage_object_is_backflow_signature(text) from public;
revoke execute on function storage_object_is_backflow_signature(text) from anon;
grant execute on function storage_object_is_backflow_signature(text) to authenticated;

-- Everything that must be compared before/after happens in this one block.
do $$
declare
  pol record;
  before_restrictive text[];
  before_other_storage text[];
  after_restrictive text[];
  after_other_storage text[];
  n int;
  cmds text;
  bad text;
  dev uuid;
begin
  select coalesce(array_agg(x order by x), '{}') into before_restrictive from (
    select polrelid::regclass::text || '|' || polname::text || '|' || polcmd::text || '|' ||
           coalesce(pg_get_expr(polqual, polrelid), '') || '|' ||
           coalesce(pg_get_expr(polwithcheck, polrelid), '') as x
      from pg_policy
     where polrelid in ('public.sites'::regclass, 'public.job_documents'::regclass)
       and not polpermissive) s;

  select coalesce(array_agg(x order by x), '{}') into before_other_storage from (
    select polname::text || '|' || polcmd::text || '|' ||
           coalesce(pg_get_expr(polqual, polrelid), '') || '|' ||
           coalesce(pg_get_expr(polwithcheck, polrelid), '') as x
      from pg_policy
     where polrelid = 'storage.objects'::regclass
       and position('backflow-certificates' in
             coalesce(pg_get_expr(polqual, polrelid), '')
          || coalesce(pg_get_expr(polwithcheck, polrelid), '')) = 0) s;

  -- drop: permissive on sites/job_documents; everything naming the bucket
  for pol in
    select polrelid::regclass::text as tbl, polname
      from pg_policy
     where polrelid in ('public.sites'::regclass, 'public.job_documents'::regclass)
       and polpermissive
  loop
    execute format('drop policy %I on %s', pol.polname, pol.tbl);
  end loop;

  for pol in
    select polname
      from pg_policy
     where polrelid = 'storage.objects'::regclass
       and position('backflow-certificates' in
             coalesce(pg_get_expr(polqual, polrelid), '')
          || coalesce(pg_get_expr(polwithcheck, polrelid), '')) > 0
  loop
    execute format('drop policy %I on storage.objects', pol.polname);
  end loop;

  -- sites (0064)
  execute $q$create policy "Authenticated users can read sites" on sites for select
    using ((select auth.role()) = 'authenticated')$q$;
  execute $q$create policy "Authenticated users can add sites" on sites for insert
    with check ((select auth.role()) = 'authenticated')$q$;
  execute $q$create policy "Office/admin can update sites" on sites for update
    using ((select is_office_or_admin(auth.uid())))
    with check ((select is_office_or_admin(auth.uid())))$q$;
  execute $q$create policy "Office/admin can delete sites" on sites for delete
    using ((select is_office_or_admin(auth.uid())))$q$;

  -- job_documents (0065)
  execute $q$create policy "Job documents readable; office-only ones office/admin" on job_documents for select
    using ((select auth.role()) = 'authenticated' and (not office_only or (select is_office_or_admin(auth.uid()))))$q$;
  execute $q$create policy "Job documents insertable; office-only ones office/admin" on job_documents for insert
    with check ((select auth.role()) = 'authenticated' and (not office_only or (select is_office_or_admin(auth.uid()))))$q$;
  execute $q$create policy "Job documents updatable; office-only ones office/admin" on job_documents for update
    using ((select auth.role()) = 'authenticated' and (not office_only or (select is_office_or_admin(auth.uid()))))
    with check ((select auth.role()) = 'authenticated' and (not office_only or (select is_office_or_admin(auth.uid()))))$q$;
  execute $q$create policy "Job documents deletable; office-only ones office/admin" on job_documents for delete
    using ((select auth.role()) = 'authenticated' and (not office_only or (select is_office_or_admin(auth.uid()))))$q$;

  -- backflow-certificates (0066)
  execute $q$create policy "backflow certificates: office/admin read all, uploader reads own signature"
    on storage.objects for select to authenticated
    using (
      bucket_id = 'backflow-certificates'
      and (
        (select is_office_or_admin(auth.uid()))
        or (owner_id = (select auth.uid())::text and storage_object_is_backflow_signature(name))
      )
    )$q$;
  execute $q$create policy "backflow certificates: signatures uploadable to an existing device"
    on storage.objects for insert to authenticated
    with check (bucket_id = 'backflow-certificates' and storage_object_is_backflow_signature(name))$q$;
  execute $q$create policy "backflow certificates: uploader may replace own signature"
    on storage.objects for update to authenticated
    using (bucket_id = 'backflow-certificates' and owner_id = (select auth.uid())::text
           and storage_object_is_backflow_signature(name))
    with check (bucket_id = 'backflow-certificates' and owner_id = (select auth.uid())::text
           and storage_object_is_backflow_signature(name))$q$;
  execute $q$create policy "backflow certificates: office/admin delete"
    on storage.objects for delete to authenticated
    using (bucket_id = 'backflow-certificates' and (select is_office_or_admin(auth.uid())))$q$;

  -- ---------------------------------------------------------------- checks
  select coalesce(array_agg(x order by x), '{}') into after_restrictive from (
    select polrelid::regclass::text || '|' || polname::text || '|' || polcmd::text || '|' ||
           coalesce(pg_get_expr(polqual, polrelid), '') || '|' ||
           coalesce(pg_get_expr(polwithcheck, polrelid), '') as x
      from pg_policy
     where polrelid in ('public.sites'::regclass, 'public.job_documents'::regclass)
       and not polpermissive) s;
  if after_restrictive is distinct from before_restrictive then
    raise exception '0117: restrictive policies on sites/job_documents changed';
  end if;

  select coalesce(array_agg(x order by x), '{}') into after_other_storage from (
    select polname::text || '|' || polcmd::text || '|' ||
           coalesce(pg_get_expr(polqual, polrelid), '') || '|' ||
           coalesce(pg_get_expr(polwithcheck, polrelid), '') as x
      from pg_policy
     where polrelid = 'storage.objects'::regclass
       and position('backflow-certificates' in
             coalesce(pg_get_expr(polqual, polrelid), '')
          || coalesce(pg_get_expr(polwithcheck, polrelid), '')) = 0) s;
  if after_other_storage is distinct from before_other_storage then
    raise exception '0117: storage.objects policies outside backflow-certificates changed';
  end if;

  if not (select relrowsecurity from pg_class where oid = 'public.sites'::regclass)
     or not (select relrowsecurity from pg_class where oid = 'public.job_documents'::regclass) then
    raise exception '0117: row level security is off on sites or job_documents';
  end if;

  -- sites: four permissive; the write ones office/admin only; no FOR ALL.
  if (select count(*) from pg_policy where polrelid = 'public.sites'::regclass and polpermissive) <> 4
     or (select count(*) from pg_policy
          where polrelid = 'public.sites'::regclass and polpermissive and polcmd in ('w', 'd')) <> 2
     or exists (select 1 from pg_policy
                 where polrelid = 'public.sites'::regclass and polpermissive and polcmd = '*') then
    raise exception '0117: sites must have 4 permissive policies: read, add, one UPDATE, one DELETE';
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

  -- job_documents: four permissive, each carrying the office_only gate.
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

  -- backflow-certificates: four permissive policies TO authenticated, one per command.
  select count(*), string_agg(polcmd::text, '' order by polcmd::text) into n, cmds
    from pg_policy
   where polrelid = 'storage.objects'::regclass
     and position('backflow-certificates' in
           coalesce(pg_get_expr(polqual, polrelid), '')
        || coalesce(pg_get_expr(polwithcheck, polrelid), '')) > 0;
  if n <> 4 or cmds <> 'adrw' then
    raise exception '0117: expected 4 backflow-certificates policies (a,d,r,w), found % (%)', n, cmds;
  end if;
  select count(*) into n
    from pg_policy
   where polrelid = 'storage.objects'::regclass
     and position('backflow-certificates' in
           coalesce(pg_get_expr(polqual, polrelid), '')
        || coalesce(pg_get_expr(polwithcheck, polrelid), '')) > 0
     and (not polpermissive or polroles <> array['authenticated'::regrole::oid]);
  if n <> 0 then
    raise exception '0117: % backflow-certificates policies are not permissive TO authenticated', n;
  end if;

  if storage_object_is_backflow_signature('00000000-0000-0000-0000-000000000000/signatures/1.png') then
    raise exception '0117: a backflow signature key naming no real device is accepted';
  end if;
  select id into dev from backflow_devices limit 1;
  if dev is not null then
    if not storage_object_is_backflow_signature(dev::text || '/signatures/1700000000000.png') then
      raise exception '0117: a real device''s signature path is refused';
    end if;
    if storage_object_is_backflow_signature(dev::text || '/' || dev::text || '_1700000000000.pdf') then
      raise exception '0117: a certificate PDF path is accepted as a signature';
    end if;
  end if;
end $$;
