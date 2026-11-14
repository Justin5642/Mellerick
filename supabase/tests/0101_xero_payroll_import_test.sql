-- ============================================================================
-- REGRESSION TEST for 0101 — Xero payroll import: links are unique, leave is
-- never imported twice, the new leave type works, and payroll stays admin-only.
--
--   psql "$SUPABASE_DB_URL" -f supabase/tests/0101_xero_payroll_import_test.sql
--   or paste the whole file into the Supabase SQL editor.
--
-- ONE DO BLOCK, SELF-UNDOING — see the 0073 test's header.
-- ============================================================================

do $$
declare
  res text[] := '{}';   -- 'scenario|expected|actual'
  tech uuid;
  adm uuid;
  other uuid;
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
    select id into other from profiles where role = 'technician' and coalesce(is_active, true) and id <> tech limit 1;
    if tech is null or adm is null then
      raise exception 'fixture missing: need an active technician and an admin';
    end if;

    perform set_config('request.jwt.claims', '', true);
    insert into staff_cost_profiles (staff_id, hourly_rate) values (tech, 40)
      on conflict (staff_id) do update set hourly_rate = excluded.hourly_rate;

    perform set_config('role', 'authenticated', true);

    -- ---- As an admin (the import runs as the admin who clicked it) ---------
    perform set_config('request.jwt.claims', json_build_object('sub', adm::text, 'role', 'authenticated')::text, true);
    begin
      update staff_cost_profiles set xero_employee_id = 'xero-emp-0101' where staff_id = tech;
      get diagnostics n = row_count;
      outcome := n::text;
    exception when others then outcome := 'ERROR: ' || sqlerrm;
    end;
    res := res || format('admin links a Xero employee (rows)|1|%s', outcome);

    if other is not null then
      begin
        insert into staff_cost_profiles (staff_id, xero_employee_id) values (other, 'xero-emp-0101')
          on conflict (staff_id) do update set xero_employee_id = excluded.xero_employee_id;
        outcome := 'ALLOWED';
      exception when unique_violation then outcome := 'BLOCKED';
      when others then outcome := 'OTHER ERROR: ' || sqlstate || ' ' || sqlerrm;
      end;
      res := res || format('same Xero employee on two people|BLOCKED|%s', outcome);
    end if;

    insert into staff_leave (staff_id, leave_type, start_date, end_date, hours, xero_leave_application_id)
      values (tech, 'long_service', current_date, current_date + 4, 38, 'xero-leave-0101');
    res := res || format('long service leave accepted|1|%s', (select count(*) from staff_leave where xero_leave_application_id = 'xero-leave-0101'));

    begin
      insert into staff_leave (staff_id, leave_type, start_date, end_date, hours, xero_leave_application_id)
        values (tech, 'annual', current_date, current_date, 7.6, 'xero-leave-0101');
      outcome := 'ALLOWED';
    exception when unique_violation then outcome := 'BLOCKED';
    when others then outcome := 'OTHER ERROR: ' || sqlstate || ' ' || sqlerrm;
    end;
    res := res || format('same Xero leave imported twice|BLOCKED|%s', outcome);

    begin
      insert into staff_leave (staff_id, leave_type, start_date, end_date, hours)
        values (tech, 'holiday', current_date, current_date, 7.6);
      outcome := 'ALLOWED';
    exception when check_violation then outcome := 'BLOCKED';
    when others then outcome := 'OTHER ERROR: ' || sqlstate || ' ' || sqlerrm;
    end;
    res := res || format('unknown leave type|BLOCKED|%s', outcome);

    -- Leave typed in the app (no Xero id) can repeat freely, as before.
    insert into staff_leave (staff_id, leave_type, start_date, end_date, hours)
      values (tech, 'sick', current_date, current_date, 7.6), (tech, 'sick', current_date, current_date, 7.6);
    res := res || format('app-entered leave unaffected|2|%s', (select count(*) from staff_leave where staff_id = tech and leave_type = 'sick' and start_date = current_date and xero_leave_application_id is null));

    -- ---- A technician still cannot see payroll ------------------------------
    perform set_config('request.jwt.claims', json_build_object('sub', tech::text, 'role', 'authenticated')::text, true);
    select count(*) into n from staff_cost_profiles;
    res := res || format('technician reads staff cost profiles|0|%s', n);
    select count(*) into n from staff_leave;
    res := res || format('technician reads staff leave|0|%s', n);

    perform set_config('request.jwt.claims', '', true);
    perform set_config('role', 'postgres', true);
    res := res || format('new profiles default to 12%% super|true|%s',
      (select column_default ~ '^\(?12(\.0+)?\)?(::numeric)?$' from information_schema.columns
        where table_schema = 'public' and table_name = 'staff_cost_profiles' and column_name = 'super_rate'));

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
    raise exception E'% of % scenario(s) FAILED — Xero payroll import:%',
      n_fail, array_length(res, 1), failures;
  end if;
  raise notice 'all % scenarios passed', array_length(res, 1);
end;
$$;
