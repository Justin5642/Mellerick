-- ============================================================================
-- GATE TEST for 0116 — job folders for documents and photos.
--
--   Paste the whole file into the Supabase SQL editor AFTER 0116.
--   Trust only a final "0116 PASSED" row; anything else is a failure.
--
-- ONE DO BLOCK, SELF-UNDOING (pattern: 0114_customer_address_doc_folders_test.sql).
-- The fixture (a customer, a job the technician is on, a job they are not on,
-- documents and photos) lives in an inner block that ends by raising a
-- private SQLSTATE, which rolls it back; the results survive in local
-- variables and are checked afterwards.
--
-- Needs an active technician and an active office/admin profile.
-- ============================================================================

do $$
declare
  tech uuid;
  off  uuid;
  cid  uuid;
  jid  uuid;
  other_jid uuid;
  doc_open uuid;
  doc_office uuid;
  photo_own uuid;
  photo_other uuid;
  failures text := '';
  ran boolean := false;
  old_doc_refused int := 0;
  old_photo_refused int := 0;
  new_doc_ok int := 0;
  new_photo_ok int := 0;
  k text;
  legacy_left int := -1;
  tech_doc_n int := -1;
  tech_office_doc_n int := -1;
  tech_photo_n int := -1;
  tech_photo_seen text;
  tech_other_photo_n int := -1;
  tech_insert_folder text;
  off_photo_n int := -1;
  null_ok boolean := false;
begin
  select id into tech from profiles where role = 'technician' and coalesce(is_active, true) order by full_name limit 1;
  select id into off  from profiles where role in ('office', 'admin') and coalesce(is_active, true) order by role desc, full_name limit 1;
  if tech is null or off is null then
    raise exception '0116 gate FAILED: needs an active technician and an active office/admin profile';
  end if;

  -- The remap: no document is left on a 0114 key.
  select count(*) into legacy_left from job_documents where folder in ('drainage', 'soil', 'site_documents', 'plumbing');
  if legacy_left <> 0 then failures := failures || legacy_left || ' document(s) still on an old folder; '; end if;

  if not has_column_privilege('authenticated', 'public.job_photos', 'folder', 'update') then
    failures := failures || 'authenticated cannot update job_photos.folder; ';
  end if;

  begin
    insert into customers (name) values ('0116 GATE customer') returning id into cid;
    insert into jobs (title, customer_id, status, assigned_to)
    values ('0116 GATE job', cid, 'pending', tech) returning id into jid;
    insert into jobs (title, customer_id, status, assigned_to)
    values ('0116 GATE other job', cid, 'pending', off) returning id into other_jid;
    insert into job_documents (job_id, storage_path, file_name) values (jid, jid || '/0116-open.pdf', '0116-open.pdf') returning id into doc_open;
    insert into job_documents (job_id, storage_path, file_name, office_only) values (jid, jid || '/0116-office.pdf', '0116-office.pdf', true) returning id into doc_office;
    insert into job_photos (job_id, storage_path, photo_type) values (jid, jid || '/0116-own.jpg', 'general') returning id into photo_own;
    insert into job_photos (job_id, storage_path, photo_type) values (other_jid, other_jid || '/0116-other.jpg', 'general') returning id into photo_other;

    -- Old keys refused, new keys accepted, NULL (Other) allowed -----------------
    foreach k in array array['drainage', 'soil', 'site_documents', 'plumbing', 'Drains', 'invoices'] loop
      begin
        update job_documents set folder = k where id = doc_open;
      exception when check_violation then old_doc_refused := old_doc_refused + 1;
      end;
      begin
        update job_photos set folder = k where id = photo_own;
      exception when check_violation then old_photo_refused := old_photo_refused + 1;
      end;
    end loop;
    foreach k in array array['drains', 'soil_rock', 'r1', 'r2', 'rough_in', 'fit_off', 'camera_inspections'] loop
      begin
        update job_documents set folder = k where id = doc_open;
        new_doc_ok := new_doc_ok + 1;
      exception when check_violation then null;
      end;
      begin
        update job_photos set folder = k where id = photo_own;
        new_photo_ok := new_photo_ok + 1;
      exception when check_violation then null;
      end;
    end loop;
    update job_documents set folder = null where id = doc_open;
    update job_photos set folder = null where id = photo_own;
    null_ok := true;

    -- Technician on the job ---------------------------------------------------------
    perform set_config('request.jwt.claims', json_build_object('sub', tech, 'role', 'authenticated')::text, true);
    execute 'set local role authenticated';
    update job_photos set folder = 'rough_in' where id = photo_own;
    get diagnostics tech_photo_n = row_count;
    select folder into tech_photo_seen from job_photos where id = photo_own;
    update job_photos set folder = 'fit_off' where id = photo_other;
    get diagnostics tech_other_photo_n = row_count;
    insert into job_photos (job_id, uploaded_by, storage_path, photo_type, folder)
    values (jid, tech, jid || '/0116-new.jpg', 'general', 'camera_inspections')
    returning folder into tech_insert_folder;
    update job_documents set folder = 'drains' where id = doc_open;
    get diagnostics tech_doc_n = row_count;
    update job_documents set folder = 'r1' where id = doc_office;
    get diagnostics tech_office_doc_n = row_count;
    execute 'reset role';

    -- Office/admin files a photo on a job they are not on --------------------------
    perform set_config('request.jwt.claims', json_build_object('sub', off, 'role', 'authenticated')::text, true);
    execute 'set local role authenticated';
    update job_photos set folder = 'r2' where id = photo_own;
    get diagnostics off_photo_n = row_count;
    execute 'reset role';

    ran := true;
    raise exception using errcode = 'ZK116', message = '0116 undo';
  exception
    when sqlstate 'ZK116' then null;
    when others then
      failures := failures || 'scenario run failed: ' || sqlerrm || '; ';
  end;

  if ran then
    if old_doc_refused <> 6 then failures := failures || 'documents accepted ' || (6 - old_doc_refused) || ' old/unknown folder(s); '; end if;
    if old_photo_refused <> 6 then failures := failures || 'photos accepted ' || (6 - old_photo_refused) || ' old/unknown folder(s); '; end if;
    if new_doc_ok <> 7 then failures := failures || 'documents refused ' || (7 - new_doc_ok) || ' new folder(s); '; end if;
    if new_photo_ok <> 7 then failures := failures || 'photos refused ' || (7 - new_photo_ok) || ' new folder(s); '; end if;
    if not null_ok then failures := failures || 'folder could not be cleared to NULL (Other); '; end if;
    if tech_photo_n <> 1 or tech_photo_seen is distinct from 'rough_in' then
      failures := failures || 'the job''s technician could not file their job''s photo; ';
    end if;
    if tech_other_photo_n <> 0 then failures := failures || 'a technician filed a photo on a job they are not on (0074 broken); '; end if;
    if tech_insert_folder is distinct from 'camera_inspections' then
      failures := failures || 'a technician could not add a photo straight into a folder; ';
    end if;
    if tech_doc_n <> 1 then failures := failures || 'the job''s technician could not file a document; '; end if;
    if tech_office_doc_n <> 0 then failures := failures || 'a technician changed an office-only document (0065 broken); '; end if;
    if off_photo_n <> 1 then failures := failures || 'office/admin could not file a photo; '; end if;
  end if;

  if failures <> '' then raise exception '0116 gate FAILED: %', failures; end if;
end $$;
select '0116 PASSED' as result;
