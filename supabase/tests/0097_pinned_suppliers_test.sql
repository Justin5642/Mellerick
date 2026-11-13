-- ============================================================================
-- REGRESSION TEST for 0097 — pinned suppliers, and who raised each PO.
--
--   psql "$SUPABASE_DB_URL" -f supabase/tests/0097_pinned_suppliers_test.sql
--   or paste the whole file into the Supabase SQL editor.
--
-- ONE DO BLOCK, SELF-UNDOING — see the 0073 test's header.
-- ============================================================================

do $$
declare
  res text[] := '{}';   -- 'scenario|expected|actual'
  sup uuid;
  cc uuid;
  job uuid;
  who uuid;
  vo uuid;
  outcome text;
  line text;
  parts text[];
  failures text := '';
  n_fail int := 0;
begin
  begin
    -- A database with no suppliers or office user yet (the CI stack) gets
    -- throwaway ones; the closing ZX001 undoes them with everything else.
    select id into sup from suppliers limit 1;
    if sup is null then
      insert into suppliers (name) values ('0097 test supplier') returning id into sup;
    end if;
    select pc.id, po.job_id into cc, job from po_cost_centers pc join purchase_orders po on po.id = pc.po_id limit 1;
    select id into who from profiles where role in ('office', 'admin') and coalesce(is_active, true)
      order by (role = 'office') desc limit 1;
    if who is null then
      who := gen_random_uuid();
      insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
        values (who, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'ci-0097-office@test.local',
                crypt('ci-password-0097', gen_salt('bf')), now(), now(), now());
      -- As the service role: if a signup trigger already made a technician
      -- profile, 0044 lets only the service role or an admin change its role.
      perform set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
      insert into profiles (id, full_name, email, role, is_active)
        values (who, 'CI Office 0097', 'ci-0097-office@test.local', 'office', true)
        on conflict (id) do update set role = 'office', is_active = true;
    end if;
    if cc is null then
      raise exception 'fixture missing: need a job with a PO cost centre line';
    end if;

    -- 1. The column exists and takes a position.
    update suppliers set pin_order = 1 where id = sup;
    res := res || format('supplier pinned|t|%s', (select pin_order = 1 from suppliers where id = sup));

    -- 2. Zero or negative positions are refused.
    begin
      update suppliers set pin_order = 0 where id = sup;
      outcome := 'ALLOWED';
    exception when check_violation then
      outcome := 'BLOCKED';
    end;
    res := res || format('pin_order 0 refused|BLOCKED|%s', outcome);

    -- 3. Unpinning is a null.
    update suppliers set pin_order = null where id = sup;
    res := res || format('supplier unpinned|t|%s', (select pin_order is null from suppliers where id = sup));

    -- 4. An office user's PO with no entered_by records them (the web PO tab).
    perform set_config('request.jwt.claims',
                       json_build_object('sub', who::text, 'role', 'authenticated')::text, true);
    insert into vendor_orders (cost_center_id, job_id, vendor_name, amount, supplier_id)
      values (cc, job, '0097 test', 0, sup)
      returning id into vo;
    res := res || format('entered_by defaults to the caller|t|%s', (select entered_by = who from vendor_orders where id = vo));

    -- 5. The recent-suppliers read has its index.
    res := res || format('created_at index present|t|%s', exists (
      select 1 from pg_indexes where tablename = 'vendor_orders' and indexname = 'vendor_orders_created_at_idx'));

    -- 6. suppliers is still office/admin only; anon has nothing.
    res := res || format('anon reads suppliers|f|%s', has_table_privilege('anon', 'public.suppliers', 'select'));

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
    raise exception E'% of % scenario(s) FAILED — pinned suppliers:%',
      n_fail, array_length(res, 1), failures;
  end if;
  raise notice 'all % scenarios passed', array_length(res, 1);
end;
$$;
