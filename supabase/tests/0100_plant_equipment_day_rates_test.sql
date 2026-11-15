-- ============================================================================
-- REGRESSION TEST for 0100 — tool days on a job: a technician can log one,
-- it counts once per job per day, and the old hours/loads entries still work.
--
--   psql "$SUPABASE_DB_URL" -f supabase/tests/0100_plant_equipment_day_rates_test.sql
--   or paste the whole file into the Supabase SQL editor.
--
-- ONE DO BLOCK, SELF-UNDOING — see the 0073 test's header. Writes run as a real
-- technician under the `authenticated` role, as the apps do. Builds its own
-- fixtures; asserts nothing about the seeded tools, which the office may edit.
-- ============================================================================

do $$
declare
  res text[] := '{}';   -- 'scenario|expected|actual'
  tech uuid;
  cust uuid := gen_random_uuid();
  mine uuid := gen_random_uuid();
  theirs uuid := gen_random_uuid();
  saw uuid := gen_random_uuid();
  truck uuid := gen_random_uuid();
  n int;
  outcome text;
  line text;
  parts text[];
  failures text := '';
  n_fail int := 0;
begin
  begin
    select id into tech from profiles where role = 'technician' and coalesce(is_active, true) limit 1;
    if tech is null then
      raise exception 'fixture missing: need an active technician';
    end if;

    perform set_config('request.jwt.claims', '', true);
    insert into customers (id, name) values (cust, '0100 Customer');
    insert into jobs (id, customer_id, assigned_to, title) values (mine, cust, tech, '0100 mine');
    insert into jobs (id, customer_id, title) values (theirs, cust, '0100 theirs');
    insert into equipment (id, name, category, day_rate) values (saw, '0100 Test Saw', 'tool', 150);
    insert into equipment (id, name, category, cost_per_load) values (truck, '0100 Test Truck', 'vehicle', 40);

    begin
      update equipment set day_rate = -1 where id = saw;
      outcome := 'ALLOWED';
    exception when check_violation then outcome := 'BLOCKED';
    end;
    res := res || format('negative day rate|BLOCKED|%s', outcome);

    perform set_config('role', 'authenticated', true);
    perform set_config('request.jwt.claims', json_build_object('sub', tech::text, 'role', 'authenticated')::text, true);

    -- 1. A tool day on the technician's own job.
    begin
      insert into equipment_usage_log (equipment_id, job_id, usage_date, hours, loads, days, logged_by)
        values (saw, mine, current_date, 0, 0, 1, tech);
      outcome := 'ALLOWED';
    exception when others then outcome := 'BLOCKED: ' || sqlerrm;
    end;
    res := res || format('tech logs a tool day on their job|ALLOWED|%s', outcome);

    -- 2. The same tool, same job, same day again (double tap / second crew member).
    begin
      insert into equipment_usage_log (equipment_id, job_id, usage_date, hours, loads, days, logged_by)
        values (saw, mine, current_date, 0, 0, 1, tech);
      outcome := 'ALLOWED';
    exception when unique_violation then outcome := 'BLOCKED';
    when others then outcome := 'OTHER ERROR: ' || sqlstate || ' ' || sqlerrm;
    end;
    res := res || format('same tool, job and day twice|BLOCKED|%s', outcome);

    -- 3. The next day is a new day.
    begin
      insert into equipment_usage_log (equipment_id, job_id, usage_date, hours, loads, days, logged_by)
        values (saw, mine, current_date + 1, 0, 0, 1, tech);
      outcome := 'ALLOWED';
    exception when others then outcome := 'BLOCKED: ' || sqlerrm;
    end;
    res := res || format('same tool on the next day|ALLOWED|%s', outcome);

    -- 4. Full days only.
    begin
      insert into equipment_usage_log (equipment_id, job_id, usage_date, hours, loads, days, logged_by)
        values (saw, mine, current_date + 2, 0, 0, 2, tech);
      outcome := 'ALLOWED';
    exception when check_violation then outcome := 'BLOCKED';
    when others then outcome := 'OTHER ERROR: ' || sqlstate || ' ' || sqlerrm;
    end;
    res := res || format('two days in one entry|BLOCKED|%s', outcome);

    -- 5. Nothing used at all is still refused.
    begin
      insert into equipment_usage_log (equipment_id, job_id, usage_date, hours, loads, days, logged_by)
        values (saw, mine, current_date + 3, 0, 0, 0, tech);
      outcome := 'ALLOWED';
    exception when check_violation then outcome := 'BLOCKED';
    when others then outcome := 'OTHER ERROR: ' || sqlstate || ' ' || sqlerrm;
    end;
    res := res || format('entry with no hours, loads or days|BLOCKED|%s', outcome);

    -- 6. Truck hours and loads work as before (two the same day is fine).
    begin
      insert into equipment_usage_log (equipment_id, job_id, usage_date, hours, loads, logged_by)
        values (truck, mine, current_date, 2, 3, tech), (truck, mine, current_date, 1, 0, tech);
      outcome := 'ALLOWED';
    exception when others then outcome := 'BLOCKED: ' || sqlerrm;
    end;
    res := res || format('truck hours and loads, twice in a day|ALLOWED|%s', outcome);

    -- 7. Not on someone else's job (0074).
    begin
      insert into equipment_usage_log (equipment_id, job_id, usage_date, hours, loads, days, logged_by)
        values (saw, theirs, current_date, 0, 0, 1, tech);
      outcome := 'ALLOWED';
    exception when insufficient_privilege then outcome := 'BLOCKED';
    when others then outcome := 'OTHER ERROR: ' || sqlstate || ' ' || sqlerrm;
    end;
    res := res || format('tool day on a job they are not on|BLOCKED|%s', outcome);

    -- 8. Undo their own tap.
    delete from equipment_usage_log where equipment_id = saw and job_id = mine and usage_date = current_date;
    get diagnostics n = row_count;
    res := res || format('tech removes their tool day|1|%s', n);

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
    parts[3] := case parts[3] when 't' then 'true' when 'f' then 'false' else parts[3] end;
    if parts[2] is distinct from parts[3] then
      n_fail := n_fail + 1;
      failures := failures || format(E'\n  - %s: expected %s, got %s', parts[1], parts[2], parts[3]);
    end if;
  end loop;
  if n_fail > 0 then
    raise exception E'% of % scenario(s) FAILED — plant day rates:%',
      n_fail, array_length(res, 1), failures;
  end if;
  raise notice 'all % scenarios passed', array_length(res, 1);
end;
$$;
