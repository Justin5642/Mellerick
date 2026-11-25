-- ============================================================================
-- Job folders for documents AND photos: Drains, Soil & Rock, R1, R2,
-- Rough In, Fit Off, Camera Inspections (+ Other = NULL).
--
-- STATUS: ✅ APPLIED IN PRODUCTION (2026-11-25, via SQL editor; gate test passed; confirmed by a read-only check). PowerSync streams must be redeployed for tech_job_photos.folder.
-- How: this file was pasted into the SQL editor, then the gate test supabase/tests/0116_folders_test.sql, and trusts only
-- the final "0116 PASSED" row. Then change this line to applied and add the
-- ledger row:
--   insert into supabase_migrations.schema_migrations (version,name)
--   values ('0116','job_folders') on conflict do nothing;
-- THEN redeploy the PowerSync streams (docs/powersync-deploy.md):
-- tech_job_photos now names `folder`, which a database without this
-- migration doesn't have.
-- Safe to merge the app before this is applied: the old folder keys are
-- read as their new folders, an upload that the old check refuses is saved
-- under Other, a move answers "folders aren't switched on yet", and the
-- phone's outbox drops job_photos.folder on a database without it
-- (mobile/lib/data/optionalColumns.ts).
--
-- WHY (Justin, 24 Nov 2026): the 0114 folders (Site Documents, Drainage,
-- Plumbing, Soil) aren't how the work is split. He chose the stages the crew
-- photograph and file against, the same list for photos and documents, and
-- technicians pick the folder when they take a photo on the phone.
--
--   job_documents.folder  remapped: drainage -> drains, soil -> soil_rock,
--                         site_documents / plumbing -> NULL (Other).
--                         Nothing is deleted; only the label moves.
--   job_photos.folder     new, same keys, NULL = Other (every existing photo).
--
-- Keys: drains | soil_rock | r1 | r2 | rough_in | fit_off | camera_inspections
--
-- WHO MAY SET IT: unchanged policies. job_documents: 0065/0074 (office-only
-- documents stay office/admin; the crew on jobs they can manage). job_photos:
-- 0074's restrictive "change only on jobs you can manage", so the job's crew
-- and office/admin may file a photo; nobody else.
--
-- GRANTS: job_photos and job_documents are granted at table level (no column
-- grants — see 0093's note for job_photos), so the new column is covered;
-- asserted below rather than assumed.
--
-- NO MONEY: `folder` doesn't match the money sweep's regex (asserted).
-- PowerSync: job_photos is in the publication as a whole table (0039, no
-- column list), so the column replicates; the tech_job_photos stream lists it.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- job_documents: drop the 0114 folder check(s) BY DEFINITION, remap, re-add.
-- ---------------------------------------------------------------------------
do $$
declare
  c record;
begin
  for c in
    select conname from pg_constraint
     where conrelid = 'public.job_documents'::regclass and contype = 'c'
       and pg_get_constraintdef(oid) ilike '%folder%'
  loop
    execute format('alter table public.job_documents drop constraint %I', c.conname);
  end loop;
end $$;

update job_documents set folder = 'drains'    where folder = 'drainage';
update job_documents set folder = 'soil_rock' where folder = 'soil';
update job_documents set folder = null        where folder in ('site_documents', 'plumbing');

alter table job_documents
  add constraint job_documents_folder_check
  check (folder is null or folder in ('drains', 'soil_rock', 'r1', 'r2', 'rough_in', 'fit_off', 'camera_inspections'));

comment on column job_documents.folder is
  'Folder: drains | soil_rock | r1 | r2 | rough_in | fit_off | camera_inspections; NULL = Other. 0114, keys replaced by 0116.';

-- ---------------------------------------------------------------------------
-- job_photos.folder — new, same keys.
-- ---------------------------------------------------------------------------
alter table job_photos add column if not exists folder text;

do $$
declare
  c record;
begin
  for c in
    select conname from pg_constraint
     where conrelid = 'public.job_photos'::regclass and contype = 'c'
       and pg_get_constraintdef(oid) ilike '%folder%'
  loop
    execute format('alter table public.job_photos drop constraint %I', c.conname);
  end loop;
end $$;

alter table job_photos
  add constraint job_photos_folder_check
  check (folder is null or folder in ('drains', 'soil_rock', 'r1', 'r2', 'rough_in', 'fit_off', 'camera_inspections'));

comment on column job_photos.folder is
  'Folder: drains | soil_rock | r1 | r2 | rough_in | fit_off | camera_inspections; NULL = Other. 0116.';

-- ---------------------------------------------------------------------------
-- End state, asserted (a paste that silently did nothing must fail loudly).
-- ---------------------------------------------------------------------------
do $$
declare
  t text;
  n int;
  def text;
begin
  foreach t in array array['job_documents', 'job_photos'] loop
    if not exists (
      select 1 from information_schema.columns
       where table_schema = 'public' and table_name = t and column_name = 'folder'
    ) then
      raise exception '0116: %.folder is missing', t;
    end if;

    select count(*) into n from pg_constraint
     where conrelid = ('public.' || t)::regclass and contype = 'c'
       and pg_get_constraintdef(oid) ilike '%folder%';
    if n <> 1 then
      raise exception '0116: % has % folder checks, expected exactly 1', t, n;
    end if;

    select pg_get_constraintdef(oid) into def from pg_constraint
     where conrelid = ('public.' || t)::regclass and conname = t || '_folder_check';
    if def is null
       or def not like '%camera_inspections%' or def not like '%rough_in%' or def not like '%soil_rock%'
       or def like '%drainage%' or def like '%site_documents%' or def like '%plumbing%' then
      raise exception '0116: %_folder_check is not the new folder list: %', t, def;
    end if;

    -- Signed-in users can read, add and change the column (RLS decides rows).
    if not has_column_privilege('authenticated', 'public.' || t, 'folder', 'SELECT')
       or not has_column_privilege('authenticated', 'public.' || t, 'folder', 'INSERT')
       or not has_column_privilege('authenticated', 'public.' || t, 'folder', 'UPDATE') then
      raise exception '0116: authenticated cannot read/insert/update %.folder', t;
    end if;
  end loop;

  if exists (select 1 from job_documents where folder in ('drainage', 'soil', 'site_documents', 'plumbing')) then
    raise exception '0116: job_documents still has old folder values';
  end if;

  if 'folder' ~* ('(rate|cost|price|amount|total|sell|margin|markup|hourly|salary|wage|charge'
               || '|fee|value|balance|paid|owing|gst|deposit|discount|surcharge|levy'
               || '|insurance|maintenance|registration|annual|subtotal|invoice_total)') then
    raise exception '0116: folder is money-named';
  end if;

  -- job_photos must still replicate to PowerSync (as a whole table).
  if exists (select 1 from pg_publication where pubname = 'powersync')
     and not exists (
       select 1 from pg_publication_tables
        where pubname = 'powersync' and schemaname = 'public' and tablename = 'job_photos'
     ) then
    raise exception '0116: job_photos is not in the powersync publication';
  end if;
end $$;
