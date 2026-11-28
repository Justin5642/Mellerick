-- ============================================================================
-- GATE TEST for 0125 — supplier credit notes against a supplier PO.
--
--   psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/0125_vendor_order_credits_test.sql
--   or paste the whole file into the Supabase SQL editor AFTER 0125.
--
-- ONE DO BLOCK, SELF-UNDOING — see the 0073 test's header. Reads and writes
-- run as a real technician, then a real office/admin user, under the
-- `authenticated` role, as the app does. Builds its own fixture (a job, a PO
-- line, a supplier order with an invoice, one credit). Trust only the final
-- "0125 PASSED" row: any failure raises, the editor shows a red error, and
-- nothing is kept.
--
-- Needs an active technician and an active office/admin profile.
-- ============================================================================

do $$
declare
  res text[] := '{}';   -- 'scenario|expected|actual'
  tech uuid;
  office uuid;
  cust uuid := gen_random_uuid();
  job uuid := gen_random_uuid();
  po uuid := gen_random_uuid();
  line uuid := gen_random_uuid();
  ord uuid := gen_random_uuid();
  bare uuid := gen_random_uuid();
  credit uuid := gen_random_uuid();
  n int;
  who uuid;
  outcome text;
  r text;
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

    -- Fixture as the service role.
    perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
    insert into customers (id, name) values (cust, 'Gate 0125 customer');
    insert into jobs (id, customer_id, title, status, assigned_to) values (job, cust, 'Gate 0125 job', 'in_progress', tech);
    insert into purchase_orders (id, job_id, po_number, total_value) values (po, job, 'G0125-1', 1000);
    insert into po_cost_centers (id, po_id, name, allocated_amount) values (line, po, 'Gate line', 1000);
    insert into vendor_orders (id, cost_center_id, job_id, vendor_name, amount, gst_amount, invoice_number, status)
    values (ord, line, job, 'Gate Supplier', 500.00, 50.00, 'GINV-1', 'received');
    insert into vendor_orders (id, cost_center_id, job_id, vendor_name, amount, gst_amount)
    values (bare, line, job, 'Gate Supplier', 0, 0);
    insert into vendor_order_credits (id, vendor_order_id, credit_number, amount_ex_gst, gst_amount)
    values (credit, ord, 'GCR-1', 100.00, 10.00);

    res := res || format('anon may read credits|false|%s',
      has_table_privilege('anon', 'public.vendor_order_credits', 'select'));
    res := res || format('anon may write credits|false|%s',
      has_table_privilege('anon', 'public.vendor_order_credits', 'insert')
      or has_table_privilege('anon', 'public.vendor_order_credits', 'update')
      or has_table_privilege('anon', 'public.vendor_order_credits', 'delete'));
    res := res || format('in a publication|false|%s',
      exists (select 1 from pg_publication_tables where tablename = 'vendor_order_credits'));

    -- ---------------------------------------------------------------- technician (on the job)
    perform set_config('role', 'authenticated', true);
    perform set_config('request.jwt.claims', json_build_object('sub', tech::text, 'role', 'authenticated')::text, true);

    select count(*) into n from vendor_order_credits where id = credit;
    res := res || format('technician reads a credit on their own job|0|%s', n);

    begin
      insert into vendor_order_credits (vendor_order_id, credit_number, amount_ex_gst) values (ord, 'GCR-T', 1);
      outcome := 'ALLOWED';
    exception when others then outcome := 'BLOCKED';
    end;
    res := res || format('technician adds a credit|BLOCKED|%s', outcome);

    begin
      update vendor_order_credits set amount_ex_gst = 1 where id = credit;
      get diagnostics n = row_count;
      outcome := case when n = 0 then 'BLOCKED' else 'ALLOWED' end;
    exception when others then outcome := 'BLOCKED';
    end;
    res := res || format('technician changes a credit|BLOCKED|%s', outcome);

    begin
      delete from vendor_order_credits where id = credit;
      get diagnostics n = row_count;
      outcome := case when n = 0 then 'BLOCKED' else 'ALLOWED' end;
    exception when others then outcome := 'BLOCKED';
    end;
    res := res || format('technician deletes a credit|BLOCKED|%s', outcome);

    -- ---------------------------------------------------------------- office
    perform set_config('request.jwt.claims', json_build_object('sub', office::text, 'role', 'authenticated')::text, true);

    select count(*) into n from vendor_order_credits where id = credit;
    res := res || format('office reads a credit|1|%s', n);

    begin
      insert into vendor_order_credits (vendor_order_id, credit_number, amount_ex_gst, gst_amount, entered_by)
      values (ord, 'GCR-2', 50.00, 5.00, tech) returning entered_by into who;
      outcome := 'ALLOWED';
    exception when others then outcome := 'BLOCKED: ' || sqlstate;
    end;
    res := res || format('office adds a credit|ALLOWED|%s', outcome);
    res := res || format('entered_by is forced to the caller|true|%s', who is not distinct from office);

    begin
      insert into vendor_order_credits (vendor_order_id, credit_number, amount_ex_gst) values (ord, 'GCR-3', 400.00);
      outcome := 'ALLOWED';
    exception when check_violation then outcome := 'REFUSED';
    when others then outcome := 'OTHER ERROR: ' || sqlstate;
    end;
    res := res || format('credits beyond the invoice amount|REFUSED|%s', outcome);

    begin
      insert into vendor_order_credits (vendor_order_id, credit_number, amount_ex_gst) values (ord, 'gcr-1 ', 1.00);
      outcome := 'ALLOWED';
    exception when unique_violation then outcome := 'REFUSED';
    when others then outcome := 'OTHER ERROR: ' || sqlstate;
    end;
    res := res || format('the same credit number twice on one PO|REFUSED|%s', outcome);

    begin
      insert into vendor_order_credits (vendor_order_id, credit_number, amount_ex_gst) values (bare, 'GCR-4', 1.00);
      outcome := 'ALLOWED';
    exception when check_violation then outcome := 'REFUSED';
    when others then outcome := 'OTHER ERROR: ' || sqlstate;
    end;
    res := res || format('a credit on a PO with no invoice|REFUSED|%s', outcome);

    begin
      insert into vendor_order_credits (vendor_order_id, credit_number, amount_ex_gst) values (ord, 'GCR-5', 0);
      outcome := 'ALLOWED';
    exception when check_violation then outcome := 'REFUSED';
    when others then outcome := 'OTHER ERROR: ' || sqlstate;
    end;
    res := res || format('a $0 credit|REFUSED|%s', outcome);

    update vendor_orders set status = 'cancelled' where id = ord;
    begin
      insert into vendor_order_credits (vendor_order_id, credit_number, amount_ex_gst) values (ord, 'GCR-6', 1.00);
      outcome := 'ALLOWED';
    exception when check_violation then outcome := 'REFUSED';
    when others then outcome := 'OTHER ERROR: ' || sqlstate;
    end;
    res := res || format('a credit on a cancelled PO|REFUSED|%s', outcome);

    delete from vendor_order_credits where id = credit;
    get diagnostics n = row_count;
    res := res || format('office deletes a credit|1|%s', n);

    perform set_config('role', 'postgres', true);
    raise exception using errcode = 'ZX001', message = 'undo test changes';
  exception when sqlstate 'ZX001' then
    null;
  end;

  if coalesce(array_length(res, 1), 0) = 0 then
    raise exception 'test recorded no scenarios';
  end if;
  foreach r in array res loop
    parts := string_to_array(r, '|');
    parts[3] := case parts[3] when 't' then 'true' when 'f' then 'false' else parts[3] end;
    if parts[2] is distinct from parts[3] then
      n_fail := n_fail + 1;
      failures := failures || format(E'\n  - %s: expected %s, got %s', parts[1], parts[2], parts[3]);
    end if;
  end loop;
  if n_fail > 0 then
    raise exception E'0125 gate FAILED — % of % scenario(s):%', n_fail, array_length(res, 1), failures;
  end if;
end;
$$;

select '0125 PASSED' as result;
