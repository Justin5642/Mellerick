-- ============================================================================
-- REGRESSION TEST for 0099 — fleet service records: who can read and write
-- them, and that the cost link cannot double-count an invoice.
--
--   psql "$SUPABASE_DB_URL" -f supabase/tests/0099_equipment_service_records_test.sql
--   or paste the whole file into the Supabase SQL editor.
--
-- ONE DO BLOCK, SELF-UNDOING — see the 0073 test's header. Writes run as a real
-- technician / office user under the `authenticated` role, as the apps do.
-- ============================================================================

do $$
declare
  res text[] := '{}';   -- 'scenario|expected|actual'
  tech uuid;
  off uuid;
  eq uuid := gen_random_uuid();
  exp uuid := gen_random_uuid();
  rec uuid := gen_random_uuid();
  n int;
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
    insert into equipment (id, name, category) values (eq, '0099 Test Ute', 'vehicle');
    insert into equipment_expenses (id, equipment_id, category, amount, gst_amount, expense_date)
      values (exp, eq, 'service', 450, 45, current_date);

    perform set_config('role', 'authenticated', true);

    -- ---- As the office -----------------------------------------------------
    perform set_config('request.jwt.claims', json_build_object('sub', off::text, 'role', 'authenticated')::text, true);
    begin
      insert into equipment_service_records (id, equipment_id, service_type, odometer_km, provider, work_done, expense_id, next_due_date, next_due_km)
        values (rec, eq, 'scheduled', 84210, '0099 Garage', 'Oil and filters', exp, current_date + 180, 94210);
      outcome := 'ALLOWED';
    exception when others then outcome := 'BLOCKED: ' || sqlerrm;
    end;
    res := res || format('office adds a service|ALLOWED|%s', outcome);
    res := res || format('logged_by defaults to the user|true|%s', (select logged_by = off from equipment_service_records where id = rec));

    begin
      insert into equipment_service_records (equipment_id, expense_id) values (eq, exp);
      outcome := 'ALLOWED';
    exception when unique_violation then outcome := 'BLOCKED';
    when others then outcome := 'OTHER ERROR: ' || sqlstate || ' ' || sqlerrm;
    end;
    res := res || format('same invoice on a second service|BLOCKED|%s', outcome);

    begin
      insert into equipment_service_records (equipment_id, odometer_km) values (eq, -5);
      outcome := 'ALLOWED';
    exception when check_violation then outcome := 'BLOCKED';
    when others then outcome := 'OTHER ERROR: ' || sqlstate || ' ' || sqlerrm;
    end;
    res := res || format('negative odometer|BLOCKED|%s', outcome);

    begin
      insert into equipment_service_records (equipment_id, service_type) values (eq, 'detailing');
      outcome := 'ALLOWED';
    exception when check_violation then outcome := 'BLOCKED';
    when others then outcome := 'OTHER ERROR: ' || sqlstate || ' ' || sqlerrm;
    end;
    res := res || format('unknown service type|BLOCKED|%s', outcome);

    -- ---- As a technician ---------------------------------------------------
    perform set_config('request.jwt.claims', json_build_object('sub', tech::text, 'role', 'authenticated')::text, true);
    select count(*) into n from equipment_service_records where id = rec;
    res := res || format('technician reads service history|1|%s', n);

    begin
      insert into equipment_service_records (equipment_id, odometer_km) values (eq, 90000);
      outcome := 'ALLOWED';
    exception when insufficient_privilege then outcome := 'BLOCKED';
    when others then outcome := 'OTHER ERROR: ' || sqlstate || ' ' || sqlerrm;
    end;
    res := res || format('technician adds a service|BLOCKED|%s', outcome);

    update equipment_service_records set odometer_km = 1 where id = rec;
    get diagnostics n = row_count;
    res := res || format('technician changes a service (rows changed)|0|%s', n);

    delete from equipment_service_records where id = rec;
    get diagnostics n = row_count;
    res := res || format('technician removes a service (rows removed)|0|%s', n);

    -- ---- Deleting the invoice keeps the service, unlinks it -----------------
    perform set_config('request.jwt.claims', '', true);
    perform set_config('role', 'postgres', true);
    delete from equipment_expenses where id = exp;
    res := res || format('service kept when its expense is deleted|true|%s', (select expense_id is null from equipment_service_records where id = rec));

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
    raise exception E'% of % scenario(s) FAILED — service records:%',
      n_fail, array_length(res, 1), failures;
  end if;
  raise notice 'all % scenarios passed', array_length(res, 1);
end;
$$;
