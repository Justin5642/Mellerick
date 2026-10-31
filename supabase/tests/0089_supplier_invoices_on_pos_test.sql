-- ============================================================================
-- REGRESSION TEST for 0089 — supplier invoices on POs, deliveries.
--
--   psql "$SUPABASE_DB_URL" -f supabase/tests/0089_supplier_invoices_on_pos_test.sql
--   or paste the whole file into the Supabase SQL editor.
--
-- ONE DO BLOCK, SELF-UNDOING — see the 0073 test's header.
-- ============================================================================

do $$
declare
  res text[] := '{}';   -- 'scenario|expected|actual'
  a uuid;
  b uuid;
  outcome text;
  line text;
  parts text[];
  failures text := '';
  n_fail int := 0;
begin
  begin
    select id into a from vendor_orders order by created_at limit 1;
    select id into b from vendor_orders where id <> a order by created_at limit 1;
    if a is null or b is null then
      raise exception 'fixture missing: need two vendor orders';
    end if;

    -- 1. An invoice saves on an order.
    update vendor_orders set invoice_number = 'INV-TEST-0089', invoice_date = current_date, amount = 123.45 where id = a;
    res := res || format('invoice saved|INV-TEST-0089|%s', (select invoice_number from vendor_orders where id = a));

    -- 2. One Xero bill links to one order only.
    update vendor_orders set xero_bill_id = 'xero-test-0089' where id = a;
    begin
      update vendor_orders set xero_bill_id = 'xero-test-0089' where id = b;
      outcome := 'ALLOWED';
    exception when unique_violation then
      outcome := 'BLOCKED';
    end;
    res := res || format('same Xero bill on two orders|BLOCKED|%s', outcome);

    -- 3. A delivery records when.
    update vendor_orders set delivered_at = now(), status = 'received' where id = b;
    res := res || format('delivery recorded|t|%s', (select delivered_at is not null from vendor_orders where id = b));

    -- 4. RLS still on, still office/admin only.
    res := res || format('vendor_orders RLS on|t|%s', (select relrowsecurity from pg_class where oid = 'public.vendor_orders'::regclass));

    raise exception using errcode = 'ZX001', message = 'undo test changes';
  exception when sqlstate 'ZX001' then
    null;
  end;

  if coalesce(array_length(res, 1), 0) = 0 then
    raise exception 'test recorded no scenarios';
  end if;
  foreach line in array res loop
    parts := string_to_array(line, '|');
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
