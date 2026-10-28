-- ============================================================================
-- REGRESSION TEST for 0085 — supplier POs raised from the phone.
--
--   psql "$SUPABASE_DB_URL" -f supabase/tests/0085_supplier_orders_test.sql
--   or paste the whole file into the Supabase SQL editor.
--
-- ONE DO BLOCK, SELF-UNDOING — see the 0073 test's header.
-- ============================================================================

do $$
declare
  res text[] := '{}';   -- 'scenario|expected|actual'
  j uuid;
  cc uuid;
  vo1 uuid := gen_random_uuid();
  vo2 uuid := gen_random_uuid();
  po1 text;
  po2 text;
  outcome text;
  line text;
  parts text[];
  failures text := '';
  n_fail int := 0;
begin
  begin
    select cc_.id, po.job_id into cc, j
      from po_cost_centers cc_ join purchase_orders po on po.id = cc_.po_id limit 1;
    if cc is null then
      raise exception 'fixture missing: need a job with a PO cost centre';
    end if;

    -- 1. No PO without a cost centre (Justin, 28 Oct 2026).
    begin
      insert into vendor_orders (job_id, vendor_name) values (j, 'No Cost Centre Supplier');
      outcome := 'ALLOWED';
    exception when not_null_violation then
      outcome := 'BLOCKED';
    end;
    res := res || format('PO without cost centre|BLOCKED|%s', outcome);

    insert into vendor_orders (id, job_id, cost_center_id, vendor_name) values (vo1, j, cc, 'Test Supplier A');
    insert into vendor_orders (id, job_id, cost_center_id, vendor_name) values (vo2, j, cc, 'Test Supplier B');
    select po_number into po1 from vendor_orders where id = vo1;
    select po_number into po2 from vendor_orders where id = vo2;

    -- 2. The database numbers each PO, and never twice.
    res := res || format('PO number assigned|t|%s', po1 like 'PO-%');
    res := res || format('PO numbers differ|t|%s', po1 is distinct from po2);
    begin
      update vendor_orders set po_number = po1 where id = vo2;
      outcome := 'ALLOWED';
    exception when unique_violation then
      outcome := 'BLOCKED';
    end;
    res := res || format('duplicate PO number|BLOCKED|%s', outcome);

    -- 3. Lines need a description and a positive quantity.
    insert into vendor_order_items (vendor_order_id, description, quantity) values (vo1, '20mm copper elbow', 4);
    begin
      insert into vendor_order_items (vendor_order_id, description) values (vo1, '   ');
      outcome := 'ALLOWED';
    exception when check_violation then
      outcome := 'BLOCKED';
    end;
    res := res || format('blank line|BLOCKED|%s', outcome);
    begin
      insert into vendor_order_items (vendor_order_id, description, quantity) values (vo1, 'Tee', 0);
      outcome := 'ALLOWED';
    exception when check_violation then
      outcome := 'BLOCKED';
    end;
    res := res || format('zero quantity|BLOCKED|%s', outcome);

    -- 4. Lines go with their order.
    delete from vendor_orders where id = vo1;
    res := res || format('lines removed with order|0|%s', (select count(*) from vendor_order_items where vendor_order_id = vo1));

    -- 5. Lines are office/admin only, like the order itself.
    res := res || format('items RLS on|t|%s', (select relrowsecurity from pg_class where relname = 'vendor_order_items'));
    res := res || format('items policy gates on office/admin|1|%s', (
      select count(*) from pg_policy p join pg_class c on c.oid = p.polrelid
      where c.relname = 'vendor_order_items'
        and pg_get_expr(p.polqual, p.polrelid) like '%is_office_or_admin%'));
    res := res || format('items policy count|1|%s', (
      select count(*) from pg_policy p join pg_class c on c.oid = p.polrelid where c.relname = 'vendor_order_items'));

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
    raise exception E'% of % scenario(s) FAILED — supplier orders:%',
      n_fail, array_length(res, 1), failures;
  end if;
  raise notice 'all % scenarios passed', array_length(res, 1);
end;
$$;
