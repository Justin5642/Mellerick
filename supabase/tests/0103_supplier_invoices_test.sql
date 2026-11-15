-- ============================================================================
-- REGRESSION TEST for 0103 — supplier invoices: office-only, a file is read
-- once, and the bucket exists and is private.
--
--   psql "$SUPABASE_DB_URL" -f supabase/tests/0103_supplier_invoices_test.sql
--   or paste the whole file into the Supabase SQL editor.
--
-- ONE DO BLOCK, SELF-UNDOING — see the 0073 test's header.
-- ============================================================================

do $$
declare
  res text[] := '{}';   -- 'scenario|expected|actual'
  tech uuid;
  office uuid;
  n int;
  outcome text;
  line text;
  parts text[];
  failures text := '';
  n_fail int := 0;
begin
  begin
    select id into tech from profiles where role = 'technician' and coalesce(is_active, true) limit 1;
    select id into office from profiles where role in ('office', 'admin') and coalesce(is_active, true) limit 1;
    if tech is null or office is null then
      raise exception 'fixture missing: need an active technician and an office/admin user';
    end if;

    perform set_config('role', 'authenticated', true);

    -- ---- Office uploads a read ------------------------------------------------
    perform set_config('request.jwt.claims', json_build_object('sub', office::text, 'role', 'authenticated')::text, true);
    begin
      insert into supplier_invoices (storage_path, file_name, file_sha256, index_in_file, uploaded_by, status)
        values ('t/0103.pdf', '0103.pdf', 'sha-0103', 0, office, 'read'),
               ('t/0103.pdf', '0103.pdf', 'sha-0103', 1, office, 'read');
      outcome := 'ALLOWED';
    exception when others then outcome := 'ERROR: ' || sqlerrm;
    end;
    res := res || format('office records two invoices from one file|ALLOWED|%s', outcome);

    begin
      insert into supplier_invoices (storage_path, file_name, file_sha256, index_in_file)
        values ('t/0103b.pdf', '0103.pdf', 'sha-0103', 0);
      outcome := 'ALLOWED';
    exception when unique_violation then outcome := 'BLOCKED';
    when others then outcome := 'OTHER ERROR: ' || sqlstate || ' ' || sqlerrm;
    end;
    res := res || format('same file read twice|BLOCKED|%s', outcome);

    begin
      insert into supplier_invoices (storage_path, file_name, file_sha256, status)
        values ('t/x.pdf', 'x.pdf', 'sha-0103-x', 'paid');
      outcome := 'ALLOWED';
    exception when check_violation then outcome := 'BLOCKED';
    when others then outcome := 'OTHER ERROR: ' || sqlstate || ' ' || sqlerrm;
    end;
    res := res || format('unknown status|BLOCKED|%s', outcome);

    -- ---- A technician sees and writes nothing --------------------------------
    perform set_config('request.jwt.claims', json_build_object('sub', tech::text, 'role', 'authenticated')::text, true);
    select count(*) into n from supplier_invoices;
    res := res || format('technician reads supplier invoices|0|%s', n);
    begin
      insert into supplier_invoices (storage_path, file_name, file_sha256) values ('t/y.pdf', 'y.pdf', 'sha-0103-y');
      outcome := 'ALLOWED';
    exception when insufficient_privilege then outcome := 'BLOCKED';
    when others then outcome := case when sqlerrm ilike '%row-level security%' then 'BLOCKED' else 'OTHER ERROR: ' || sqlerrm end;
    end;
    res := res || format('technician inserts a supplier invoice|BLOCKED|%s', outcome);

    perform set_config('request.jwt.claims', '', true);
    perform set_config('role', 'postgres', true);
    res := res || format('bucket exists and is private|false|%s',
      coalesce((select public::text from storage.buckets where id = 'supplier-invoices'), 'missing'));

    raise exception using errcode = 'ZX001', message = 'undo test changes';
  exception when sqlstate 'ZX001' then
    null;
  end;

  if coalesce(array_length(res, 1), 0) = 0 then
    raise exception 'test recorded no scenarios';
  end if;
  foreach line in array res loop
    parts := string_to_array(line, '|');
    parts[3] := case parts[3] when 't' then 'true' when 'f' then 'false' else parts[3] end;
    if parts[2] is distinct from parts[3] then
      n_fail := n_fail + 1;
      failures := failures || format(E'\n  - %s: expected %s, got %s', parts[1], parts[2], parts[3]);
    end if;
  end loop;
  if n_fail > 0 then
    raise exception E'% of % scenario(s) FAILED — supplier invoices:%',
      n_fail, array_length(res, 1), failures;
  end if;
  raise notice 'all % scenarios passed', array_length(res, 1);
end;
$$;
