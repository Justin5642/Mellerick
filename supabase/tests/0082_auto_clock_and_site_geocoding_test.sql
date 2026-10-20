-- ============================================================================
-- REGRESSION TEST for 0082 — auto_clock is admin-only.
--
--   psql "$SUPABASE_DB_URL" -f supabase/tests/0082_auto_clock_and_site_geocoding_test.sql
--   or paste the whole file into the Supabase SQL editor.
--
-- ONE DO BLOCK, SELF-UNDOING — see the 0073 test's header.
-- ============================================================================

do $$
declare
  res text[] := '{}';   -- 'scenario|expected|actual'
  tech uuid;
  adm uuid;
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
      raise exception 'fixture missing: need an active technician and admin';
    end if;

    -- 1. A technician cannot switch their own auto clock off.
    perform set_config('request.jwt.claims', json_build_object('sub', tech::text, 'role', 'authenticated')::text, true);
    begin
      perform set_config('role', 'authenticated', true);
      update profiles set auto_clock = false where id = tech;
      perform set_config('role', 'postgres', true);
      outcome := 'ALLOWED';
    exception when others then
      perform set_config('role', 'postgres', true);
      outcome := 'BLOCKED';
    end;
    res := res || format('technician changes own auto clock|BLOCKED|%s', outcome);

    -- 2. …but can still edit their own name.
    begin
      perform set_config('role', 'authenticated', true);
      update profiles set full_name = full_name where id = tech;
      perform set_config('role', 'postgres', true);
      outcome := 'ALLOWED';
    exception when others then
      perform set_config('role', 'postgres', true);
      outcome := 'BLOCKED';
    end;
    res := res || format('technician edits own name|ALLOWED|%s', outcome);

    -- 3. An admin can switch it for anyone, including themselves.
    perform set_config('request.jwt.claims', json_build_object('sub', adm::text, 'role', 'authenticated')::text, true);
    begin
      update profiles set auto_clock = true where id = adm;
      outcome := 'ALLOWED';
    exception when others then
      outcome := 'BLOCKED';
    end;
    res := res || format('admin turns on their own auto clock|ALLOWED|%s', outcome);
    res := res || format('the switch is stored|true|%s', (select auto_clock from profiles where id = adm));

    -- 4. The service role (the admin API route) can too.
    perform set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
    begin
      update profiles set auto_clock = null where id = tech;
      outcome := 'ALLOWED';
    exception when others then
      outcome := 'BLOCKED';
    end;
    res := res || format('service role resets to by-role|ALLOWED|%s', outcome);

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
    raise exception E'% of % scenario(s) FAILED — auto clock switch:%',
      n_fail, array_length(res, 1), failures;
  end if;
  raise notice 'all % scenarios passed', array_length(res, 1);
end;
$$;
