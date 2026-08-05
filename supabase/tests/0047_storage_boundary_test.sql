-- ============================================================================
-- Does migration 0047 actually refuse a technician? Ask the database, do not
-- reason about the policies.
--
--   psql "$SUPABASE_DB_URL" -f supabase/tests/0047_storage_boundary_test.sql
--
-- Read-only. Everything runs inside a transaction that is ROLLED BACK.
--
-- Run this BEFORE applying 0047 and AFTER. Before, the money rows should read
-- READABLE WITH DATA. After, they should read blocked/0 rows while the general
-- job-document row stays readable. A test that only ever runs after the fix
-- cannot tell you the fix was the thing that changed.
--
-- WHY THE POSITIVE CONTROLS MATTER. tests/rls/financial-tables.test.ts asserts
-- `toHaveLength(0)` against tables it never seeds, so it passes whether or not
-- the policy exists. The 'office CAN read' and 'technician CAN still read
-- general documents' cases below are what stop this test rotting the same way:
-- if a policy is written too tightly, those go red instead of everything
-- silently going green.
-- ============================================================================

begin;

create temp table probe(
  scenario text,
  expectation text,
  observed text,
  rows_seen int
) on commit drop;

do $$
declare
  tech uuid;
  office uuid;
  n int;
begin
  select id into tech   from profiles where role = 'technician' limit 1;
  select id into office from profiles where role in ('office','admin') limit 1;

  if tech is null then
    raise exception 'no technician in profiles — this test proves nothing without one';
  end if;
  if office is null then
    raise exception 'no office/admin in profiles — the positive controls cannot run';
  end if;

  -- ---------------------------------------------------------------------
  -- TECHNICIAN
  -- ---------------------------------------------------------------------
  perform set_config('request.jwt.claims',
                     json_build_object('sub', tech::text, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);

  -- 1. equipment-documents: expense receipts and service invoices. MUST be 0.
  begin
    select count(*) into n from storage.objects where bucket_id = 'equipment-documents';
    perform set_config('role', 'postgres', true);
    insert into probe values (
      'technician reads equipment-documents', 'MUST be 0 rows',
      case when n > 0 then 'LEAK — READABLE WITH DATA' else 'ok — 0 rows' end, n);
  exception when others then
    perform set_config('role', 'postgres', true);
    insert into probe values (
      'technician reads equipment-documents', 'MUST be 0 rows', 'ok — refused: ' || sqlerrm, 0);
  end;

  -- 2. job-documents EXPENSE RECEIPTS. MUST be 0.
  perform set_config('role', 'authenticated', true);
  begin
    select count(*) into n from storage.objects
     where bucket_id = 'job-documents' and name like '%/expense-receipt-%';
    perform set_config('role', 'postgres', true);
    insert into probe values (
      'technician reads job expense receipts', 'MUST be 0 rows',
      case when n > 0 then 'LEAK — READABLE WITH DATA' else 'ok — 0 rows' end, n);
  exception when others then
    perform set_config('role', 'postgres', true);
    insert into probe values (
      'technician reads job expense receipts', 'MUST be 0 rows', 'ok — refused: ' || sqlerrm, 0);
  end;

  -- 3. job-documents VARIATION ATTACHMENTS (supplier quotes/invoices). MUST be 0.
  perform set_config('role', 'authenticated', true);
  begin
    select count(*) into n from storage.objects
     where bucket_id = 'job-documents' and name like '%/variations/%';
    perform set_config('role', 'postgres', true);
    insert into probe values (
      'technician reads variation attachments', 'MUST be 0 rows',
      case when n > 0 then 'LEAK — READABLE WITH DATA' else 'ok — 0 rows' end, n);
  exception when others then
    perform set_config('role', 'postgres', true);
    insert into probe values (
      'technician reads variation attachments', 'MUST be 0 rows', 'ok — refused: ' || sqlerrm, 0);
  end;

  -- 4. POSITIVE CONTROL — general job documents must STILL be readable.
  --    The Documents tab is technician-visible (mobile/app/job/[id].tsx:186).
  --    If this reads 0, 0047 is too tight and has broken the tab.
  perform set_config('role', 'authenticated', true);
  begin
    select count(*) into n from storage.objects
     where bucket_id = 'job-documents'
       and name not like '%/expense-receipt-%'
       and name not like '%/variations/%';
    perform set_config('role', 'postgres', true);
    insert into probe values (
      'technician reads GENERAL job documents', 'MUST be > 0 rows',
      case when n > 0 then 'ok — still readable' else 'BROKEN — tab has no data' end, n);
  exception when others then
    perform set_config('role', 'postgres', true);
    insert into probe values (
      'technician reads GENERAL job documents', 'MUST be > 0 rows',
      'BROKEN — refused: ' || sqlerrm, 0);
  end;

  -- 5. POSITIVE CONTROL — job photos must STILL be readable. 0047 must not
  --    have collateral reach into the buckets technicians live in.
  perform set_config('role', 'authenticated', true);
  begin
    select count(*) into n from storage.objects where bucket_id = 'job-photos';
    perform set_config('role', 'postgres', true);
    insert into probe values (
      'technician reads job-photos', 'MUST be > 0 rows',
      case when n > 0 then 'ok — untouched' else 'BROKEN — photos not readable' end, n);
  exception when others then
    perform set_config('role', 'postgres', true);
    insert into probe values (
      'technician reads job-photos', 'MUST be > 0 rows', 'BROKEN — refused: ' || sqlerrm, 0);
  end;

  -- ---------------------------------------------------------------------
  -- OFFICE — the money documents must remain reachable for the people whose
  -- job it is. A lock that also locks out the office is a broken feature, not
  -- a secure one.
  -- ---------------------------------------------------------------------
  perform set_config('request.jwt.claims',
                     json_build_object('sub', office::text, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
  begin
    select count(*) into n from storage.objects
     where bucket_id = 'job-documents' and name like '%/expense-receipt-%';
    perform set_config('role', 'postgres', true);
    insert into probe values (
      'office reads job expense receipts', 'MUST be > 0 rows',
      case when n > 0 then 'ok — office retains access' else 'BROKEN — office locked out' end, n);
  exception when others then
    perform set_config('role', 'postgres', true);
    insert into probe values (
      'office reads job expense receipts', 'MUST be > 0 rows', 'BROKEN — refused: ' || sqlerrm, 0);
  end;

  perform set_config('role', 'postgres', true);
end;
$$;

-- ---------------------------------------------------------------------------
-- An empty bucket proves nothing. If a count below is 0 because there are no
-- objects of that kind at all, the corresponding technician assertion is
-- trivially true and this test told you nothing. Read this table first.
-- ---------------------------------------------------------------------------
select
  'GROUND TRUTH (as postgres — what actually exists)' as note,
  (select count(*) from storage.objects where bucket_id = 'equipment-documents')          as equipment_documents,
  (select count(*) from storage.objects
     where bucket_id = 'job-documents' and name like '%/expense-receipt-%')               as job_expense_receipts,
  (select count(*) from storage.objects
     where bucket_id = 'job-documents' and name like '%/variations/%')                    as variation_attachments,
  (select count(*) from storage.objects
     where bucket_id = 'job-documents'
       and name not like '%/expense-receipt-%' and name not like '%/variations/%')        as general_job_documents,
  (select count(*) from storage.objects where bucket_id = 'job-photos')                   as job_photos;

select * from probe;

rollback;
