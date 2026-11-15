-- ============================================================================
-- REGRESSION TEST for 0104 — leave balances: admin-only, one per person per
-- Xero leave type, known categories only.
--
--   psql "$SUPABASE_DB_URL" -f supabase/tests/0104_staff_leave_balances_test.sql
--   or paste the whole file into the Supabase SQL editor.
--
-- ONE DO BLOCK, SELF-UNDOING — see the 0073 test's header.
-- ============================================================================

do $$
declare
  res text[] := '{}';   -- 'scenario|expected|actual'
  tech uuid;
  adm uuid;
  n int;
  outcome text;
  line text;
  parts text[];
  failures text := '';
  n_fail int := 0;
begin
  begin
    select id into tech from profiles where role = 'technician' and coalesce(is_active, true) limit 1;
    select id into adm from profiles where role = 'admin' and coalesce(is_active, true) limit 1;
    if tech is null or adm is null then
      raise exception 'fixture missing: need an active technician and an admin';
    end if;

    perform set_config('role', 'authenticated', true);

    perform set_config('request.jwt.claims', json_build_object('sub', adm::text, 'role', 'authenticated')::text, true);
    begin
      insert into staff_leave_balances (staff_id, xero_leave_type_id, leave_name, leave_type, hours, imported_by)
        values (tech, 'xlt-0104-annual', 'Annual Leave', 'annual', 76.4, adm),
               (tech, 'xlt-0104-sick', 'Personal/Carer''s Leave', 'sick', -3.8, adm);
      outcome := 'ALLOWED';
    exception when others then outcome := 'ERROR: ' || sqlerrm;
    end;
    res := res || format('admin saves balances, negative allowed|ALLOWED|%s', outcome);

    begin
      insert into staff_leave_balances (staff_id, xero_leave_type_id, leave_name, hours)
        values (tech, 'xlt-0104-annual', 'Annual Leave', 10);
      outcome := 'ALLOWED';
    exception when unique_violation then outcome := 'BLOCKED';
    when others then outcome := 'OTHER ERROR: ' || sqlstate || ' ' || sqlerrm;
    end;
    res := res || format('same leave type twice for one person|BLOCKED|%s', outcome);

    begin
      insert into staff_leave_balances (staff_id, xero_leave_type_id, leave_name, leave_type, hours)
        values (tech, 'xlt-0104-x', 'Holiday', 'holiday', 1);
      outcome := 'ALLOWED';
    exception when check_violation then outcome := 'BLOCKED';
    when others then outcome := 'OTHER ERROR: ' || sqlstate || ' ' || sqlerrm;
    end;
    res := res || format('unknown leave category|BLOCKED|%s', outcome);

    perform set_config('request.jwt.claims', json_build_object('sub', tech::text, 'role', 'authenticated')::text, true);
    select count(*) into n from staff_leave_balances;
    res := res || format('technician reads leave balances|0|%s', n);

    perform set_config('request.jwt.claims', '', true);
    perform set_config('role', 'postgres', true);

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
    raise exception E'% of % scenario(s) FAILED — leave balances:%',
      n_fail, array_length(res, 1), failures;
  end if;
  raise notice 'all % scenarios passed', array_length(res, 1);
end;
$$;
