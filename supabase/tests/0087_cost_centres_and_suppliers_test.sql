-- ============================================================================
-- REGRESSION TEST for 0087 — company cost centres and the supplier list.
--
--   psql "$SUPABASE_DB_URL" -f supabase/tests/0087_cost_centres_and_suppliers_test.sql
--   or paste the whole file into the Supabase SQL editor.
--
-- ONE DO BLOCK, SELF-UNDOING — see the 0073 test's header.
-- ============================================================================

do $$
declare
  res text[] := '{}';   -- 'scenario|expected|actual'
  s uuid := gen_random_uuid();
  vo uuid;
  outcome text;
  line text;
  parts text[];
  failures text := '';
  n_fail int := 0;
begin
  begin
    -- 1. The four company cost centres exist, once each.
    res := res || format('starting cost centres|4|%s', (
      select count(*) from cost_centres
      where name in ('Below Ground Drainage', 'Transport', 'Above Ground Plumbing', 'Civil')));
    begin
      insert into cost_centres (name) values (' transport ');
      outcome := 'ALLOWED';
    exception when unique_violation then
      outcome := 'BLOCKED';
    end;
    res := res || format('duplicate cost centre name|BLOCKED|%s', outcome);

    -- 2. Every stage template sits under a cost centre; Truck Cartage is gone.
    res := res || format('templates without a cost centre|0|%s', (
      select count(*) from cost_center_templates where cost_centre_id is null));
    res := res || format('Truck Cartage group left|0|%s', (
      select count(*) from cost_center_templates where group_name = 'Truck Cartage'));

    -- 3. Budget lines can be tagged to a company cost centre. (Not checked by
    --    name: since Stage 2 the office sets any line's cost centre, so
    --    "Sewer cartage" under Transport is right. Re-running this test on
    --    2 Nov 2026 failed on exactly that.)
    res := res || format('budget lines have a cost centre column|1|%s', (
      select count(*) from information_schema.columns where table_name = 'po_cost_centers' and column_name = 'cost_centre_id'));

    -- 4. Suppliers: Xero id is unique; an order can point at one.
    insert into suppliers (id, name, xero_contact_id) values (s, 'Test Supplier 0087', 'xero-test-0087');
    begin
      insert into suppliers (name, xero_contact_id) values ('Copy', 'xero-test-0087');
      outcome := 'ALLOWED';
    exception when unique_violation then
      outcome := 'BLOCKED';
    end;
    res := res || format('duplicate Xero contact|BLOCKED|%s', outcome);
    select id into vo from vendor_orders limit 1;
    if vo is not null then
      update vendor_orders set supplier_id = s where id = vo;
      res := res || format('order links to supplier|t|%s', (select supplier_id = s from vendor_orders where id = vo));
    end if;

    -- 5. RLS: suppliers office/admin only; cost centres readable by all, written by office/admin.
    res := res || format('suppliers RLS on|t|%s', (select relrowsecurity from pg_class where relname = 'suppliers'));
    res := res || format('suppliers policies all gate on office/admin|1|%s', (
      select count(*) from pg_policy p join pg_class c on c.oid = p.polrelid
      where c.relname = 'suppliers' and pg_get_expr(p.polqual, p.polrelid) like '%is_office_or_admin%'));
    res := res || format('suppliers policy count|1|%s', (
      select count(*) from pg_policy p join pg_class c on c.oid = p.polrelid where c.relname = 'suppliers'));
    res := res || format('cost centres RLS on|t|%s', (select relrowsecurity from pg_class where relname = 'cost_centres'));
    res := res || format('cost centres write policy gates on office/admin|1|%s', (
      select count(*) from pg_policy p join pg_class c on c.oid = p.polrelid
      where c.relname = 'cost_centres' and p.polcmd = '*'
        and pg_get_expr(p.polwithcheck, p.polrelid) like '%is_office_or_admin%'));

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
    raise exception E'% of % scenario(s) FAILED — cost centres and suppliers:%',
      n_fail, array_length(res, 1), failures;
  end if;
  raise notice 'all % scenarios passed', array_length(res, 1);
end;
$$;
