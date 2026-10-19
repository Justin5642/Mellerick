-- ============================================================================
-- REGRESSION TEST for 0081 — manual invoice payments.
--
--   psql "$SUPABASE_DB_URL" -f supabase/tests/0081_invoice_payments_test.sql
--   or paste the whole file into the Supabase SQL editor.
--
-- ONE DO BLOCK, SELF-UNDOING — see the 0073 test's header.
--
-- SIDE EFFECT: the fixture inserts two invoices; invoices.invoice_number is a
-- serial, so the next real invoice skips two numbers.
-- ============================================================================

do $$
declare
  res text[] := '{}';   -- 'scenario|expected|actual'
  tech uuid;
  off uuid;
  cust uuid := gen_random_uuid();
  inv uuid := gen_random_uuid();
  xinv uuid := gen_random_uuid();
  p1 uuid;
  r record;
  outcome text;
  line text;
  parts text[];
  failures text := '';
  n_fail int := 0;
begin
  begin
    select id into tech from profiles where role = 'technician' and coalesce(is_active, true) limit 1;
    select id into off from profiles where role in ('office', 'admin') and coalesce(is_active, true)
      order by (role = 'office') desc limit 1;
    if tech is null or off is null then
      raise exception 'fixture missing: need an active technician and an office user or admin';
    end if;

    perform set_config('request.jwt.claims', '', true);
    insert into customers (id, name) values (cust, '0081 Customer');
    insert into invoices (id, customer_id, title, subtotal, tax_amount, total, status, due_date)
      values (inv, cust, '0081 manual', 909.09, 90.91, 1000, 'sent', current_date + 14),
             (xinv, cust, '0081 in Xero', 909.09, 90.91, 1000, 'sent', current_date + 14);
    update invoices set xero_invoice_id = 'xero-test-0081' where id = xinv;

    perform set_config('request.jwt.claims', json_build_object('sub', off::text, 'role', 'authenticated')::text, true);

    -- 1. A part-payment: balance tracked, still sent.
    insert into invoice_payments (invoice_id, amount, method) values (inv, 400, 'bank_transfer') returning id into p1;
    select * into r from invoices where id = inv;
    res := res || format('part-payment sets amount_paid|400.00|%s', r.amount_paid);
    res := res || format('part-payment leaves it sent|sent|%s', r.status);

    -- 2. The rest: paid, with paid_at.
    insert into invoice_payments (invoice_id, amount, method, paid_on) values (inv, 600, 'cash', current_date - 1);
    select * into r from invoices where id = inv;
    res := res || format('paying the balance marks it paid|paid|%s', r.status);
    res := res || format('paid_at is set|true|%s', r.paid_at is not null);

    -- 3. Removing a payment puts it back to sent with the right balance.
    delete from invoice_payments where id = p1;
    select * into r from invoices where id = inv;
    res := res || format('removing a payment reopens it|sent|%s', r.status);
    res := res || format('removing a payment reduces amount_paid|600.00|%s', r.amount_paid);
    res := res || format('reopened invoice has no paid_at|true|%s', r.paid_at is null);

    -- 4. Reopened past its due date: overdue, not sent.
    update invoices set due_date = current_date - 3 where id = inv;
    insert into invoice_payments (invoice_id, amount) values (inv, 400) returning id into p1;
    delete from invoice_payments where id = p1;
    res := res || format('reopened past due date is overdue|overdue|%s', (select status from invoices where id = inv));

    -- 5. Invoices in Xero refuse manual payments.
    begin
      insert into invoice_payments (invoice_id, amount) values (xinv, 100);
      outcome := 'ALLOWED';
    exception when others then
      outcome := 'BLOCKED';
    end;
    res := res || format('a payment on a Xero invoice is refused|BLOCKED|%s', outcome);

    -- 6. A technician cannot record or read payments.
    perform set_config('request.jwt.claims', json_build_object('sub', tech::text, 'role', 'authenticated')::text, true);
    begin
      perform set_config('role', 'authenticated', true);
      insert into invoice_payments (invoice_id, amount) values (inv, 5);
      perform set_config('role', 'postgres', true);
      outcome := 'ALLOWED';
    exception when others then
      perform set_config('role', 'postgres', true);
      outcome := 'BLOCKED';
    end;
    res := res || format('a technician cannot record a payment|BLOCKED|%s', outcome);

    -- 7. Not visible without signing in.
    res := res || format('anon cannot read invoice_payments|false|%s',
      has_table_privilege('anon', 'public.invoice_payments', 'select'));

    raise exception using errcode = 'ZX001', message = 'undo test changes';
  exception when sqlstate 'ZX001' then
    null;
  end;

  if coalesce(array_length(res, 1), 0) = 0 then
    raise exception 'test recorded no scenarios';
  end if;
  foreach line in array res loop
    parts := string_to_array(line, '|');
    -- format('%s', <boolean>) writes t / f; compare as true / false.
    parts[3] := case parts[3] when 't' then 'true' when 'f' then 'false' else parts[3] end;
    if parts[2] is distinct from parts[3] then
      n_fail := n_fail + 1;
      failures := failures || format(E'\n  - %s: expected %s, got %s', parts[1], parts[2], parts[3]);
    end if;
  end loop;
  if n_fail > 0 then
    raise exception E'% of % scenario(s) FAILED — invoice payments:%',
      n_fail, array_length(res, 1), failures;
  end if;
  raise notice 'all % scenarios passed', array_length(res, 1);
end;
$$;
