-- ============================================================================
-- GATE TEST for 0124 — supplier invoices from Gmail.
--
--   psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/0124_gmail_supplier_invoices_test.sql
--   or paste the whole file into the Supabase SQL editor AFTER 0124.
--
-- ONE DO BLOCK, SELF-UNDOING — see the 0073 test's header. Reads and writes
-- run as a real technician, then a real office/admin user, under the
-- `authenticated` role, as the app does. Builds its own fixture row. Trust
-- only the final "0124 PASSED" row: any failure raises, the editor shows a
-- red error, and nothing is kept.
--
-- Needs an active technician and an active office/admin profile.
-- ============================================================================

do $$
declare
  res text[] := '{}';   -- 'scenario|expected|actual'
  tech uuid;
  office uuid;
  row_id uuid := gen_random_uuid();
  msg text := 'gate-0124-' || gen_random_uuid()::text;
  n int;
  outcome text;
  line text;
  parts text[];
  failures text := '';
  n_fail int := 0;
begin
  begin
    select id into tech from profiles
     where role = 'technician' and coalesce(is_active, true) and not coalesce(limited_access, false) limit 1;
    select id into office from profiles where role in ('office', 'admin') and coalesce(is_active, true) limit 1;
    if tech is null or office is null then
      raise exception 'fixture missing: need an active technician and an active office/admin user';
    end if;

    -- Fixture as the service role (the hourly import writes this way).
    perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
    insert into gmail_supplier_invoices (id, gmail_message_id, part_id, file_name, status, supplier_name,
                                         invoice_number, amount_ex_gst, gst_amount, total)
    values (row_id, msg, '1', 'inv.pdf', 'needs_review', 'Gate Supplier', 'G-1', 100.00, 10.00, 110.00);

    res := res || format('anon may read imported invoices|false|%s',
      has_table_privilege('anon', 'public.gmail_supplier_invoices', 'select'));
    res := res || format('anon may write imported invoices|false|%s',
      has_table_privilege('anon', 'public.gmail_supplier_invoices', 'insert')
      or has_table_privilege('anon', 'public.gmail_supplier_invoices', 'update'));
    res := res || format('anon may read the Gmail settings|false|%s',
      has_table_privilege('anon', 'public.gmail_invoice_settings', 'select'));
    res := res || format('signed-in users may write the import state|false|%s',
      has_column_privilege('authenticated', 'public.gmail_invoice_settings', 'last_error', 'update')
      or has_column_privilege('authenticated', 'public.gmail_invoice_settings', 'gmail_allowed', 'update'));
    res := res || format('in a publication|false|%s',
      exists (select 1 from pg_publication_tables
               where tablename in ('gmail_supplier_invoices', 'gmail_invoice_settings')));

    -- ---------------------------------------------------------------- technician
    perform set_config('role', 'authenticated', true);
    perform set_config('request.jwt.claims', json_build_object('sub', tech::text, 'role', 'authenticated')::text, true);

    select count(*) into n from gmail_supplier_invoices where id = row_id;
    res := res || format('technician reads an imported invoice|0|%s', n);

    begin
      insert into gmail_supplier_invoices (gmail_message_id, part_id) values (msg, '9');
      outcome := 'ALLOWED';
    exception when insufficient_privilege then outcome := 'BLOCKED';
    when others then outcome := 'OTHER ERROR: ' || sqlstate;
    end;
    res := res || format('technician inserts an imported invoice|BLOCKED|%s', outcome);

    begin
      update gmail_supplier_invoices set status = 'dismissed' where id = row_id;
      get diagnostics n = row_count;
      outcome := case when n = 0 then 'BLOCKED' else 'ALLOWED' end;
    exception when insufficient_privilege then outcome := 'BLOCKED';
    end;
    res := res || format('technician updates an imported invoice|BLOCKED|%s', outcome);

    begin
      delete from gmail_supplier_invoices where id = row_id;
      get diagnostics n = row_count;
      outcome := case when n = 0 then 'BLOCKED' else 'ALLOWED' end;
    exception when insufficient_privilege then outcome := 'BLOCKED';
    end;
    res := res || format('technician deletes an imported invoice|BLOCKED|%s', outcome);

    select count(*) into n from gmail_invoice_settings;
    res := res || format('technician reads the Gmail settings|0|%s', n);

    begin
      update gmail_invoice_settings set label_name = 'Hacked' where id;
      get diagnostics n = row_count;
      outcome := case when n = 0 then 'BLOCKED' else 'ALLOWED' end;
    exception when insufficient_privilege then outcome := 'BLOCKED';
    end;
    res := res || format('technician changes the label|BLOCKED|%s', outcome);

    -- ---------------------------------------------------------------- office
    perform set_config('request.jwt.claims', json_build_object('sub', office::text, 'role', 'authenticated')::text, true);

    select count(*) into n from gmail_supplier_invoices where id = row_id;
    res := res || format('office reads an imported invoice|1|%s', n);

    update gmail_supplier_invoices set status = 'dismissed', handled_by = office, handled_at = now() where id = row_id;
    get diagnostics n = row_count;
    res := res || format('office dismisses an imported invoice|1|%s', n);

    begin
      insert into gmail_supplier_invoices (gmail_message_id, part_id) values (msg, '2');
      outcome := 'ALLOWED';
    exception when others then outcome := 'BLOCKED: ' || sqlstate;
    end;
    res := res || format('office inserts an imported invoice|ALLOWED|%s', outcome);

    begin
      insert into gmail_supplier_invoices (gmail_message_id, part_id) values (msg, '1');
      outcome := 'ALLOWED';
    exception when unique_violation then outcome := 'UNIQUE';
    when others then outcome := 'OTHER ERROR: ' || sqlstate;
    end;
    res := res || format('the same message + attachment twice|UNIQUE|%s', outcome);

    begin
      update gmail_supplier_invoices set status = 'bogus' where id = row_id;
      outcome := 'ALLOWED';
    exception when check_violation then outcome := 'REFUSED';
    end;
    res := res || format('an unknown status|REFUSED|%s', outcome);

    select count(*) into n from gmail_invoice_settings;
    res := res || format('office reads the Gmail settings|1|%s', n);

    update gmail_invoice_settings set label_name = 'Bills', updated_by = office, updated_at = now() where id;
    get diagnostics n = row_count;
    res := res || format('office changes the label|1|%s', n);

    begin
      update gmail_invoice_settings set last_error = 'forged' where id;
      outcome := 'ALLOWED';
    exception when insufficient_privilege then outcome := 'BLOCKED';
    end;
    res := res || format('office forges the import state|BLOCKED|%s', outcome);

    begin
      update gmail_invoice_settings set label_name = '   ' where id;
      outcome := 'ALLOWED';
    exception when check_violation then outcome := 'REFUSED';
    end;
    res := res || format('a blank label|REFUSED|%s', outcome);

    -- The PO flag the import sets and the office clears.
    perform set_config('role', 'postgres', true);
    res := res || format('vendor_orders.invoice_needs_check defaults to false|false|%s',
      (select column_default from information_schema.columns
        where table_schema = 'public' and table_name = 'vendor_orders' and column_name = 'invoice_needs_check'));

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
    raise exception E'0124 gate FAILED — % of % scenario(s):%', n_fail, array_length(res, 1), failures;
  end if;
end;
$$;

select '0124 PASSED' as result;
