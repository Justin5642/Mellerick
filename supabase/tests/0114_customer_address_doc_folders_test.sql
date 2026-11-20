-- ============================================================================
-- GATE TEST for 0114 — customer billing address and job document folders.
--
--   Paste the whole file into the Supabase SQL editor AFTER 0114.
--   Trust only a final "0114 PASSED" row; anything else is a failure.
--
-- ONE DO BLOCK, SELF-UNDOING (pattern: 0113_komtrax_test.sql). The fixture
-- (a customer, a job, two documents) lives in an inner block that ends by
-- raising a private SQLSTATE, which rolls it back; the results survive in
-- local variables and are checked afterwards.
--
-- Needs an active technician and an active office/admin profile.
-- ============================================================================

do $$
declare
  tech uuid;
  off  uuid;
  cid  uuid;
  jid  uuid;
  doc_open uuid;
  doc_office uuid;
  failures text := '';
  ran boolean := false;
  long_refused boolean := false;
  bad_folder_refused boolean := false;
  off_addr_n int := -1;
  off_addr text;
  tech_folder_n int := -1;
  tech_office_folder_n int := -1;
  off_office_folder_n int := -1;
  tech_folder_seen text;
  null_folder_ok boolean := false;
begin
  select id into tech from profiles where role = 'technician' and coalesce(is_active, true) order by full_name limit 1;
  select id into off  from profiles where role in ('office', 'admin') and coalesce(is_active, true) order by role desc, full_name limit 1;
  if tech is null or off is null then
    raise exception '0114 gate FAILED: needs an active technician and an active office/admin profile';
  end if;

  -- Structure ---------------------------------------------------------------------
  if not has_column_privilege('authenticated', 'public.customers', 'billing_address', 'select') then
    failures := failures || 'authenticated cannot read customers.billing_address; ';
  end if;
  if not has_column_privilege('authenticated', 'public.job_documents', 'folder', 'update') then
    failures := failures || 'authenticated cannot update job_documents.folder; ';
  end if;

  begin
    insert into customers (name, company) values ('0114 GATE customer', '0114 Gate Pty Ltd') returning id into cid;
    insert into jobs (title, customer_id, status, assigned_to)
    values ('0114 GATE job', cid, 'pending', tech) returning id into jid;
    insert into job_documents (job_id, storage_path, file_name) values (jid, jid || '/0114-open.pdf', '0114-open.pdf') returning id into doc_open;
    insert into job_documents (job_id, storage_path, file_name, office_only) values (jid, jid || '/0114-office.pdf', '0114-office.pdf', true) returning id into doc_office;

    -- Checks ------------------------------------------------------------------------
    begin
      update customers set billing_address = repeat('x', 501) where id = cid;
    exception when check_violation then long_refused := true;
    end;
    begin
      update job_documents set folder = 'invoices' where id = doc_open;
    exception when check_violation then bad_folder_refused := true;
    end;
    update job_documents set folder = null where id = doc_open;
    null_folder_ok := true;

    -- Office/admin: sets the address and files both documents -------------------
    perform set_config('request.jwt.claims', json_build_object('sub', off, 'role', 'authenticated')::text, true);
    execute 'set local role authenticated';
    update customers set billing_address = E'PO Box 114\nNutfield VIC 3099' where id = cid;
    get diagnostics off_addr_n = row_count;
    select billing_address into off_addr from customers where id = cid;
    update job_documents set folder = 'soil' where id = doc_office;
    get diagnostics off_office_folder_n = row_count;
    execute 'reset role';

    -- Technician on the job: files the open document, not the office-only one ----
    perform set_config('request.jwt.claims', json_build_object('sub', tech, 'role', 'authenticated')::text, true);
    execute 'set local role authenticated';
    update job_documents set folder = 'drainage' where id = doc_open;
    get diagnostics tech_folder_n = row_count;
    update job_documents set folder = 'plumbing' where id = doc_office;
    get diagnostics tech_office_folder_n = row_count;
    select folder into tech_folder_seen from job_documents where id = doc_open;
    execute 'reset role';

    ran := true;
    raise exception using errcode = 'ZK114', message = '0114 undo';
  exception
    when sqlstate 'ZK114' then null;
    when others then
      failures := failures || 'scenario run failed: ' || sqlerrm || '; ';
  end;

  if ran then
    if not long_refused then failures := failures || 'a 501-character billing address was accepted; '; end if;
    if not bad_folder_refused then failures := failures || 'an unknown folder was accepted; '; end if;
    if not null_folder_ok then failures := failures || 'folder could not be cleared to NULL (Other); '; end if;
    if off_addr_n <> 1 or off_addr is distinct from E'PO Box 114\nNutfield VIC 3099' then
      failures := failures || 'office/admin could not set a billing address; ';
    end if;
    if off_office_folder_n <> 1 then failures := failures || 'office/admin could not file an office-only document; '; end if;
    if tech_folder_n <> 1 or tech_folder_seen is distinct from 'drainage' then
      failures := failures || 'the job''s technician could not file a document; ';
    end if;
    if tech_office_folder_n <> 0 then failures := failures || 'a technician changed an office-only document (0065 broken); '; end if;
  end if;

  if failures <> '' then raise exception '0114 gate FAILED: %', failures; end if;
end $$;
select '0114 PASSED' as result;
