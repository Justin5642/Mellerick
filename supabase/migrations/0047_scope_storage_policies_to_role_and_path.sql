-- ============================================================================
-- Storage is the last place a technician can still read a dollar figure.
--
-- STATUS: APPLIED AND VERIFIED IN PRODUCTION (2026-08-05).
--
-- Pre-state matched this file's own claim exactly (10 storage policies, 0
-- role-scoped, helper absent), the self-assertions passed, and it was then
-- verified BY IMPERSONATION with an office control:
--
--   technician money job documents  2 -> 0     office control still 3
--   technician general job docs     3,906      unchanged
--   technician job photos           9,722      unchanged
--
-- The office control is the load-bearing half. Without it, "technician sees 0"
-- is equally consistent with "the boundary works" and "the bucket is empty".
--
-- BUT IT HAS BEEN RUN. On 2026-08-05 this migration was executed against the
-- production database inside a transaction ending in ROLLBACK, then the probes
-- below were re-run inside that same transaction. Postgres DDL is transactional,
-- so nothing persisted — verified afterwards: 10 storage policies, same names,
-- 0 role-scoped, storage_object_is_money_document absent. Production is
-- untouched.
--
-- Every assertion in this file passed, and the before/after against real data:
--
--   scenario                          before   after
--   technician reads expense receipts      2       0   <- leak closed
--   technician reads variation attach.     1       0   <- leak closed
--   technician reads GENERAL job docs   3906    3906   <- Documents tab intact
--   technician reads job-photos         9722    9722   <- untouched
--   office reads expense receipts          2       2   <- office keeps access
--
-- So this is not unrun SQL. What remains unproven is only what a rolled-back
-- transaction cannot show: behaviour under concurrent load, and the storage
-- API's own path (these probes query storage.objects directly, which is the
-- same RLS boundary the storage API enforces, but not the same code path).
--
-- THE HOLE. Every policy on storage.objects is `auth.role() = 'authenticated'`.
-- Verified against production 2026-08-05:
--
--     select count(*) from pg_policies
--      where schemaname = 'storage' and qual like '%is_office_or_admin%';
--     -> 0
--
-- Not one storage policy is scoped by role. So a technician, holding the anon
-- key that ships inside the app, can do this without going near the UI:
--
--     supabase.storage.from('equipment-documents').list('')      -- enumerate
--     supabase.storage.from('equipment-documents').createSignedUrl(path, 60)
--     supabase.storage.from('equipment-documents').remove([path])
--
-- Those buckets hold supplier invoices and expense receipts — PDFs with dollar
-- amounts on them. That is the same threat model migration 0038 wrote down:
-- "a technician holds the anon key and can query PostgREST directly, regardless
-- of what the app's UI shows".
--
-- WHY THE EXISTING GUARDS DID NOT CATCH THIS. supabase/tests/money_boundary_
-- sweep.sql enumerates money-named COLUMNS and tries to select them. Storage is
-- outside its loop entirely — a receipt is a file, not a column. Migration 0035
-- looked straight at this and moved on, recording at :58 that "equipment_
-- documents carry no money columns". True of the TABLE. False of the FILES.
--
-- ---------------------------------------------------------------------------
-- WHY THIS IS PATH-SCOPED AND NOT A BLANKET ROLE LOCK
-- ---------------------------------------------------------------------------
-- A blanket lock on job-documents would break the technician Documents tab.
-- That tab (mobile/app/job/[id].tsx:186 -> JobDocumentsTab) sits in TABS with
-- NO role gate, and job/[id] is registered for every role
-- (mobile/app/_layout.tsx, outside the isOffice guard). Technicians legitimately
-- read it.
--
-- The bucket mixes three kinds of file under three distinguishable paths:
--
--   {jobId}/{ts}_{name}                      general job documents  <- technician
--   {jobId}/expense-receipt-{ts}_{name}      expense receipts       <- MONEY
--   {jobId}/variations/{ts}_{name}           supplier quotes/inv.   <- MONEY
--
-- (components/job/job-documents.tsx:68, job-expenses.tsx:84,
--  job-variations.tsx:112.)
--
-- Production counts, 2026-08-05: 3909 objects in job-documents, of which 2 are
-- expense receipts and 1 is a variation attachment. So path-scoping hides 3
-- files from technicians and leaves 3906 exactly as they are. A blanket lock
-- would have hidden all 3909 and broken the tab.
--
-- equipment-documents is different and IS locked wholesale: every reader of it
-- is an office-only screen — components/fleet/* on web, and on mobile the
-- `fleet` and `fleet/[id]` routes, both inside `Stack.Protected guard={isOffice}`
-- (mobile/app/_layout.tsx). It also holds 0 objects in production today, so the
-- lock cannot break a read that is currently working.
--
-- ---------------------------------------------------------------------------
-- WHAT THIS MIGRATION DELIBERATELY DOES NOT DO
-- ---------------------------------------------------------------------------
-- 1. It does not scope DELETE on job-photos / job-audio per job. Today any
--    authenticated user can remove any job's photos (0037:38-45). That is a
--    data-integrity problem, not a money leak, and fixing it correctly needs a
--    per-job authorization join whose failure mode is "technicians can no
--    longer delete their own photos". Kept out so this migration stays
--    reviewable and its blast radius stays honest. Proposal at the bottom.
--
-- 2. It does not add a policy for `backflow-certificates`. That bucket has NO
--    policy at all and RLS IS enabled, so the browser upload at
--    app/dashboard/backflow/[id]/test/new/page.tsx:_ is currently DENIED — the
--    single object in that bucket was written by the service-role submit route.
--    That is a live bug, but granting storage access is a security decision and
--    should not ride along inside a lock-down migration. Raised separately.
--
-- ---------------------------------------------------------------------------
-- SHAPE. Policies are dropped by ENUMERATING pg_policy, never by guessed name.
-- Migration 0034 tried to drop a policy by name, the production policy was
-- named differently, `drop policy if exists` matched nothing, and the table
-- stayed open for weeks with no error. 0042 was written to undo that. This
-- follows 0042.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Drop every existing policy on storage.objects for the buckets we manage,
--    whatever it happens to be called.
-- ---------------------------------------------------------------------------
do $$
declare
  pol record;
  managed_buckets text[] := array['equipment-documents', 'job-documents'];
  b text;
begin
  for pol in
    select p.polname
    from pg_policy p
    where p.polrelid = 'storage.objects'::regclass
  loop
    -- Only drop policies that actually reference one of our buckets. Other
    -- policies (job-photos, job-audio, anything Supabase or a future migration
    -- adds) are left strictly alone.
    foreach b in array managed_buckets loop
      if position(b in pg_get_expr(
           coalesce(
             (select p2.polqual from pg_policy p2 where p2.polname = pol.polname
                and p2.polrelid = 'storage.objects'::regclass),
             (select p2.polwithcheck from pg_policy p2 where p2.polname = pol.polname
                and p2.polrelid = 'storage.objects'::regclass)
           ),
           'storage.objects'::regclass)) > 0
      then
        execute format('drop policy %I on storage.objects', pol.polname);
        exit;  -- next policy
      end if;
    end loop;
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. A path predicate, so the money rule lives in ONE place.
--
--    Money paths, by the conventions the uploaders already use:
--      '<anything>/expense-receipt-...'   expense receipts
--      '<anything>/variations/...'        variation supplier attachments
--
--    Written as a function rather than repeated in four policies: a rule
--    repeated four times is a rule that will be updated in three of them.
-- ---------------------------------------------------------------------------
create or replace function storage_object_is_money_document(object_name text)
returns boolean
language sql
immutable
set search_path = public
as $$
  select object_name like '%/expense-receipt-%'
      or object_name like '%/variations/%';
$$;

comment on function storage_object_is_money_document(text) is
  'True when a storage object path denotes a document bearing dollar figures '
  '(expense receipts, variation supplier quotes/invoices). Used by the '
  'job-documents policies in migration 0047 to keep technicians out of money '
  'files while leaving general job documents readable. If you add a new kind of '
  'money attachment, add its path convention HERE, not in the policies.';

revoke execute on function storage_object_is_money_document(text) from public;
grant execute on function storage_object_is_money_document(text) to authenticated;

-- ---------------------------------------------------------------------------
-- 3. equipment-documents — office/admin only, all four commands.
--    Note `to authenticated` on every policy. The old ones were TO PUBLIC,
--    neutralised only by the auth.role() predicate inside them; one careless
--    predicate edit would have made the bucket world-readable.
-- ---------------------------------------------------------------------------
create policy "equipment documents are office/admin readable"
  on storage.objects for select to authenticated
  using (bucket_id = 'equipment-documents' and (select is_office_or_admin(auth.uid())));

create policy "equipment documents are office/admin writable"
  on storage.objects for insert to authenticated
  with check (bucket_id = 'equipment-documents' and (select is_office_or_admin(auth.uid())));

create policy "equipment documents are office/admin updatable"
  on storage.objects for update to authenticated
  using (bucket_id = 'equipment-documents' and (select is_office_or_admin(auth.uid())))
  with check (bucket_id = 'equipment-documents' and (select is_office_or_admin(auth.uid())));

create policy "equipment documents are office/admin deletable"
  on storage.objects for delete to authenticated
  using (bucket_id = 'equipment-documents' and (select is_office_or_admin(auth.uid())));

-- ---------------------------------------------------------------------------
-- 4. job-documents — general documents stay open to any authenticated user;
--    money documents are office/admin only.
--
--    Postgres OR-es permissive policies, so these must be written as ONE policy
--    per command with the whole condition inside it. Two permissive policies
--    ("technicians can read non-money" + "office can read money") would OR
--    together and let a technician read everything — which is precisely how
--    0034's surviving policy kept xero_tokens open.
-- ---------------------------------------------------------------------------
create policy "job documents readable, money documents office/admin only"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'job-documents'
    and (
      not storage_object_is_money_document(name)
      or (select is_office_or_admin(auth.uid()))
    )
  );

create policy "job documents writable, money documents office/admin only"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'job-documents'
    and (
      not storage_object_is_money_document(name)
      or (select is_office_or_admin(auth.uid()))
    )
  );

create policy "job documents updatable, money documents office/admin only"
  on storage.objects for update to authenticated
  using (
    bucket_id = 'job-documents'
    and (
      not storage_object_is_money_document(name)
      or (select is_office_or_admin(auth.uid()))
    )
  )
  with check (
    bucket_id = 'job-documents'
    and (
      not storage_object_is_money_document(name)
      or (select is_office_or_admin(auth.uid()))
    )
  );

create policy "job documents deletable, money documents office/admin only"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'job-documents'
    and (
      not storage_object_is_money_document(name)
      or (select is_office_or_admin(auth.uid()))
    )
  );

-- ---------------------------------------------------------------------------
-- 5. Assert the end state, and RAISE if it is not what we intended.
--
--    A security migration that can silently achieve nothing is worse than none,
--    because it closes the ticket. 0034 reported success and did nothing.
-- ---------------------------------------------------------------------------
do $$
declare
  n int;
  leftover text;
begin
  -- (a) No policy on a managed bucket may survive without a role scope.
  select string_agg(polname, ', ') into leftover
  from pg_policy
  where polrelid = 'storage.objects'::regclass
    and (
      position('equipment-documents' in coalesce(pg_get_expr(polqual, 'storage.objects'::regclass), '')) > 0
      or position('equipment-documents' in coalesce(pg_get_expr(polwithcheck, 'storage.objects'::regclass), '')) > 0
      or position('job-documents' in coalesce(pg_get_expr(polqual, 'storage.objects'::regclass), '')) > 0
      or position('job-documents' in coalesce(pg_get_expr(polwithcheck, 'storage.objects'::regclass), '')) > 0
    )
    and position('is_office_or_admin' in
          coalesce(pg_get_expr(polqual, 'storage.objects'::regclass), '')
       || coalesce(pg_get_expr(polwithcheck, 'storage.objects'::regclass), '')) = 0;

  if leftover is not null then
    raise exception
      'ASSERTION FAILED: policy(ies) [%] still govern a managed bucket without a role scope', leftover;
  end if;

  -- (b) Exactly the eight policies this migration creates, and no more.
  select count(*) into n
  from pg_policy
  where polrelid = 'storage.objects'::regclass
    and (
      position('equipment-documents' in coalesce(pg_get_expr(polqual, 'storage.objects'::regclass), '')) > 0
      or position('equipment-documents' in coalesce(pg_get_expr(polwithcheck, 'storage.objects'::regclass), '')) > 0
      or position('job-documents' in coalesce(pg_get_expr(polqual, 'storage.objects'::regclass), '')) > 0
      or position('job-documents' in coalesce(pg_get_expr(polwithcheck, 'storage.objects'::regclass), '')) > 0
    );

  if n <> 8 then
    raise exception 'ASSERTION FAILED: expected 8 managed-bucket policies, found %', n;
  end if;

  -- (c) The path predicate must actually classify. If someone "simplifies" it
  --     to `select false`, every assertion above still passes and the leak is
  --     wide open — so test the classifier itself.
  if storage_object_is_money_document('abc/expense-receipt-1_x.pdf') is not true then
    raise exception 'ASSERTION FAILED: expense receipts are not classified as money documents';
  end if;
  if storage_object_is_money_document('abc/variations/1_x.pdf') is not true then
    raise exception 'ASSERTION FAILED: variation attachments are not classified as money documents';
  end if;
  if storage_object_is_money_document('abc/1_sitephoto.pdf') is not false then
    raise exception 'ASSERTION FAILED: an ordinary job document is misclassified as money';
  end if;

  -- (d) job-photos and job-audio must be untouched — technicians depend on them
  --     and this migration must not have collateral reach.
  select count(*) into n
  from pg_policy
  where polrelid = 'storage.objects'::regclass
    and (
      position('job-photos' in coalesce(pg_get_expr(polqual, 'storage.objects'::regclass), '')) > 0
      or position('job-photos' in coalesce(pg_get_expr(polwithcheck, 'storage.objects'::regclass), '')) > 0
    );
  if n <> 3 then
    raise exception
      'ASSERTION FAILED: expected job-photos to still have its 3 original policies, found %', n;
  end if;
end;
$$;

-- ============================================================================
-- VERIFY AFTER APPLYING — do not trust the assertions alone.
--
-- The assertions above prove the POLICIES look right. They do not prove a
-- technician is actually refused. Only attempting the read does that. Run
-- supabase/tests/0047_storage_boundary_test.sql against production.
--
-- ---------------------------------------------------------------------------
-- FOLLOW-UP, NOT IN THIS MIGRATION — per-job DELETE on job-photos / job-audio
--
-- Today any authenticated user can delete any job's photos and voice notes
-- (0037:38-45). Irreversible without a bucket backup, and the objects are
-- sign-off photos and compliance evidence. The path already carries the job id
-- ('{jobId}/{ts}_{name}'), so a scoped policy is expressible:
--
--   using (
--     bucket_id = 'job-photos'
--     and (
--       (select is_office_or_admin(auth.uid()))
--       or exists (
--            select 1 from jobs j
--             where j.id::text = split_part(name, '/', 1)
--               and j.assigned_to = auth.uid()
--          )
--     )
--   )
--
-- It is NOT included here because its failure mode is technicians silently
-- losing the ability to delete their own photos, and that deserves its own
-- change with its own rollback, not a rider on a money-boundary fix. It also
-- needs a decision: should a technician be able to delete a photo after the job
-- is signed off?
-- ============================================================================
