-- =============================================
-- BACKFLOW-CERTIFICATES STORAGE: CONVERGE THE POLICIES, FIX MOBILE SIGNATURE UPSERT
-- STATUS: ✅ APPLIED IN PRODUCTION (2026-10-08, via SQL editor).
--
-- WHERE THIS STARTS. 0047's "DELIBERATELY DOES NOT DO" item 2 says this bucket
-- has RLS on and no policy, so the browser signature upload is refused. That
-- note is out of date: 0048 added three policies (its header records it as
-- run against production on 2026-08-05) and 0049 creates the bucket, private,
-- for a database rebuilt from migrations. What this file fixes is what 0048
-- left behind, and it re-states 0048's grants so the bucket converges to one
-- known set whatever production actually holds.
--
-- EVERY CALLER OF THIS BUCKET (web and mobile, read from source):
--
--   client session  web  app/dashboard/backflow/[id]/test/new/page.tsx
--                        upload(`${deviceId}/signatures/${Date.now()}.png`)
--                        plain upload, no upsert            -> needs INSERT
--   client session  mob  mobile/lib/data/repositories/backflow.ts logTest()
--                        `${deviceId}/signatures/${rowId}.png`, uploaded by the
--                        outbox through gateway.supabase.ts uploadObject() with
--                        `upsert: true`                     -> needs INSERT,
--                                                              SELECT, UPDATE
--   service role    web  api/backflow/tests/[id]/submit      download signature,
--                                                             upload PDF
--                        api/backflow/tests/[id]/certificate createSignedUrl
--                        (service role bypasses RLS; unaffected either way)
--
-- THE GAP 0048 LEFT. It granted INSERT only. storage-js documents upsert as
-- needing SELECT, INSERT and UPDATE on storage.objects
-- (node_modules/@supabase/storage-js/dist/index.cjs:700), and the mobile app
-- always upserts so an offline replay lands on the same key. So a technician's
-- signature upload from the PHONE is refused, uploadObject throws, and the
-- outbox retries the whole backflow test until it dead-letters — the test row
-- is never written, because the upload runs before the row insert. The web
-- path (no upsert) is the one 0048 fixed. Not yet confirmed against the
-- deployed storage-api; see VERIFY at the bottom.
--
-- WHO GETS WHAT. Backflow testing is technician work (lib/nav-items.ts
-- tech: true; the mobile Backflow tab). Certificates are compliance documents,
-- not money documents — but no client reads them directly; every read goes
-- through the service-role certificate route. So:
--
--   SELECT  office/admin: whole bucket (unchanged from 0048).
--           anyone signed in: ONLY a signature object they uploaded themselves
--           (storage.objects.owner_id = auth.uid()). Needed for the upsert;
--           grants nobody another person's signature or any certificate PDF.
--   INSERT  anyone signed in, ONLY `<existing backflow device id>/signatures/<file>`
--           — exactly three segments, first one a real device. Certificate
--           PDFs (`<deviceId>/<testId>_<ts>.pdf`) cannot be forged.
--   UPDATE  ONLY a signature object you uploaded, and only into a signature
--           path you could INSERT. Both USING and WITH CHECK written out (0044).
--   DELETE  office/admin only (unchanged from 0048).
--   anon    nothing. Every policy is TO authenticated.
--
-- Drops this bucket's policies by ENUMERATING pg_policy (0042/0047/0049), never
-- by guessed name, leaves every other storage policy alone, and asserts the
-- end state. Idempotent and safe to re-run.
-- Proven on the CI stack by tests/rls/backflow-certificates.test.ts.
-- =============================================

-- ---------------------------------------------------------------------------
-- 0. Snapshot every OTHER storage.objects policy, to prove at the end that this
--    migration touched only its own bucket.
-- ---------------------------------------------------------------------------
drop table if exists pg_temp.m0066_other_storage_policies;
create temp table m0066_other_storage_policies as
  select p.polname, p.polcmd,
         coalesce(pg_get_expr(p.polqual, p.polrelid), '')
      || coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '') as body
  from pg_policy p
  where p.polrelid = 'storage.objects'::regclass
    and position('backflow-certificates' in
          coalesce(pg_get_expr(p.polqual, p.polrelid), '')
       || coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '')) = 0;

-- ---------------------------------------------------------------------------
-- 1. Drop whatever governs this bucket, whatever it is called. Body matched on
--    polqual || polwithcheck (0049:265-268), so a policy naming the bucket only
--    in its WITH CHECK is caught too.
-- ---------------------------------------------------------------------------
do $$
declare
  pol record;
begin
  for pol in
    select p.polname
    from pg_policy p
    where p.polrelid = 'storage.objects'::regclass
      and position('backflow-certificates' in
            coalesce(pg_get_expr(p.polqual, p.polrelid), '')
         || coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '')) > 0
  loop
    execute format('drop policy %I on storage.objects', pol.polname);
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. The signature path rule, in ONE place.
--
--    `<deviceId>/signatures/<file>` and nothing deeper, where <deviceId> names a
--    real backflow device. Compares d.id::text, never casts the path to uuid: a
--    malformed key must evaluate to false, not raise (0049's helper, same
--    reason). SECURITY INVOKER: backflow_devices is readable by every signed-in
--    user (0021), so the caller's own RLS is enough and no privilege is lent.
-- ---------------------------------------------------------------------------
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
  'The only path a client may write in that bucket (migration 0066); certificate PDFs '
  'are written by the service-role submit route.';

revoke execute on function storage_object_is_backflow_signature(text) from public;
revoke execute on function storage_object_is_backflow_signature(text) from anon;
grant execute on function storage_object_is_backflow_signature(text) to authenticated;

-- ---------------------------------------------------------------------------
-- 3. Recreate. One permissive policy per command, whole condition inside it.
-- ---------------------------------------------------------------------------
create policy "backflow certificates: office/admin read all, uploader reads own signature"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'backflow-certificates'
    and (
      (select is_office_or_admin(auth.uid()))
      or (
        owner_id = (select auth.uid())::text
        and storage_object_is_backflow_signature(name)
      )
    )
  );

create policy "backflow certificates: signatures uploadable to an existing device"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'backflow-certificates'
    and storage_object_is_backflow_signature(name)
  );

create policy "backflow certificates: uploader may replace own signature"
  on storage.objects for update to authenticated
  using (
    bucket_id = 'backflow-certificates'
    and owner_id = (select auth.uid())::text
    and storage_object_is_backflow_signature(name)
  )
  with check (
    bucket_id = 'backflow-certificates'
    and owner_id = (select auth.uid())::text
    and storage_object_is_backflow_signature(name)
  );

create policy "backflow certificates: office/admin delete"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'backflow-certificates'
    and (select is_office_or_admin(auth.uid()))
  );

-- ---------------------------------------------------------------------------
-- 4. Assert the end state.
-- ---------------------------------------------------------------------------
do $$
declare
  n int;
  cmds text;
  dev uuid;
begin
  -- (a) The bucket exists and is private. A public bucket serves objects to
  --     anyone with the URL and makes every policy here decorative.
  select count(*) into n from storage.buckets where id = 'backflow-certificates' and not public;
  if n <> 1 then
    raise exception 'ASSERTION FAILED: backflow-certificates bucket missing or PUBLIC';
  end if;

  -- (b) Exactly four policies name the bucket: one per command, all permissive,
  --     all TO authenticated only.
  select count(*), string_agg(p.polcmd::text, '' order by p.polcmd::text) into n, cmds
  from pg_policy p
  where p.polrelid = 'storage.objects'::regclass
    and position('backflow-certificates' in
          coalesce(pg_get_expr(p.polqual, p.polrelid), '')
       || coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '')) > 0;
  if n <> 4 or cmds <> 'adrw' then
    raise exception 'ASSERTION FAILED: expected 4 backflow-certificates policies (a,d,r,w), found % (%)', n, cmds;
  end if;

  select count(*) into n
  from pg_policy p
  where p.polrelid = 'storage.objects'::regclass
    and position('backflow-certificates' in
          coalesce(pg_get_expr(p.polqual, p.polrelid), '')
       || coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '')) > 0
    and (not p.polpermissive or p.polroles <> array['authenticated'::regrole::oid]);
  if n <> 0 then
    raise exception 'ASSERTION FAILED: % backflow-certificates policies are not permissive TO authenticated', n;
  end if;

  -- (c) INSERT and UPDATE actually carry the path rule, and UPDATE carries an
  --     explicit WITH CHECK (no implicit USING reuse — the 0044 shape).
  select count(*) into n
  from pg_policy p
  where p.polrelid = 'storage.objects'::regclass
    and p.polcmd in ('a', 'w')
    and position('backflow-certificates' in coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '')) > 0
    and position('storage_object_is_backflow_signature' in pg_get_expr(p.polwithcheck, p.polrelid)) > 0;
  if n <> 2 then
    raise exception 'ASSERTION FAILED: INSERT/UPDATE on backflow-certificates do not both enforce the signature path';
  end if;

  -- (d) The path rule must discriminate, in both directions.
  if storage_object_is_backflow_signature('00000000-0000-0000-0000-000000000000/signatures/1.png') then
    raise exception 'ASSERTION FAILED: a key naming no real device is accepted';
  end if;
  if storage_object_is_backflow_signature('not-a-uuid/signatures/1.png') is not false then
    raise exception 'ASSERTION FAILED: a non-uuid device key is not cleanly refused';
  end if;
  select id into dev from backflow_devices limit 1;
  if dev is not null then
    if not storage_object_is_backflow_signature(dev::text || '/signatures/1700000000000.png') then
      raise exception 'ASSERTION FAILED: a real device''s signature path is refused';
    end if;
    if storage_object_is_backflow_signature(dev::text || '/' || dev::text || '_1700000000000.pdf') then
      raise exception 'ASSERTION FAILED: a certificate PDF path is accepted as a signature';
    end if;
    if storage_object_is_backflow_signature(dev::text || '/signatures/a/b.png') then
      raise exception 'ASSERTION FAILED: a nested path under signatures/ is accepted';
    end if;
  else
    raise warning 'no backflow device exists — the positive half of the path test could not run';
  end if;

  -- (e) Nothing else on storage.objects moved.
  select count(*) into n from (
    (select polname, polcmd, body from m0066_other_storage_policies
     except
     select p.polname, p.polcmd,
            coalesce(pg_get_expr(p.polqual, p.polrelid), '')
         || coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '')
     from pg_policy p where p.polrelid = 'storage.objects'::regclass)
    union all
    (select p.polname, p.polcmd,
            coalesce(pg_get_expr(p.polqual, p.polrelid), '')
         || coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '')
     from pg_policy p
     where p.polrelid = 'storage.objects'::regclass
       and position('backflow-certificates' in
             coalesce(pg_get_expr(p.polqual, p.polrelid), '')
          || coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '')) = 0
     except
     select polname, polcmd, body from m0066_other_storage_policies)
  ) diff;
  if n <> 0 then
    raise exception 'ASSERTION FAILED: % storage.objects policies outside backflow-certificates changed', n;
  end if;
end;
$$;

drop table if exists pg_temp.m0066_other_storage_policies;

-- ============================================================================
-- VERIFY AFTER APPLYING (from real sessions — the assertions above prove the
-- policies' shape, not the storage-api's behaviour):
--
--   technician, mobile app: log a backflow test WITH a signature while online;
--     the outbox op must settle and backflow_tests.signature_storage_path be
--     set. Then replay it (upload twice to the same key) — must succeed.
--   technician: upload to '<deviceId>/<anything>.pdf'      -> refused
--   technician: upload to '<random uuid>/signatures/x.png' -> refused
--   technician: createSignedUrl on a certificate PDF        -> refused
--   office: createSignedUrl on a certificate PDF            -> allowed
--   web /dashboard/backflow/<id>/test/new: no "Failed to save signature" toast.
--
-- REVERT: drop the four policies above and `drop function
-- storage_object_is_backflow_signature(text)`, then re-run 0048's three
-- create-policy statements (this re-breaks the mobile upsert).
-- ============================================================================
