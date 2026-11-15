-- ============================================================================
-- REGRESSION TEST for 0102 — each phone writes only its own auto clock status;
-- office/admin read everyone's; a technician reads only their own.
--
--   psql "$SUPABASE_DB_URL" -f supabase/tests/0102_auto_clock_status_test.sql
--   or paste the whole file into the Supabase SQL editor.
--
-- ONE DO BLOCK, SELF-UNDOING — see the 0073 test's header.
-- ============================================================================

do $$
declare
  res text[] := '{}';   -- 'scenario|expected|actual'
  tech uuid;
  other uuid;
  off uuid;
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
    -- A second person whose row the technician must not touch: another
    -- technician if there is one, else the office user.
    select id into other from profiles where coalesce(is_active, true) and id <> tech
      order by (role = 'technician') desc limit 1;

    perform set_config('request.jwt.claims', '', true);
    delete from auto_clock_status where staff_id in (tech, other);
    insert into auto_clock_status (staff_id, tracking, reason) values (other, false, 'off-hours');

    perform set_config('role', 'authenticated', true);

    -- ---- As the technician -------------------------------------------------
    perform set_config('request.jwt.claims', json_build_object('sub', tech::text, 'role', 'authenticated')::text, true);
    begin
      insert into auto_clock_status (staff_id, tracking, background_off, site_count, platform, app_version)
        values (tech, true, true, 3, 'ios', '1.0.0 (28)')
        on conflict (staff_id) do update set tracking = excluded.tracking, background_off = excluded.background_off, updated_at = now();
      outcome := 'ALLOWED';
    exception when others then outcome := 'BLOCKED: ' || sqlerrm;
    end;
    res := res || format('tech reports their own status|ALLOWED|%s', outcome);

    begin
      update auto_clock_status set background_off = false where staff_id = tech;
      get diagnostics n = row_count;
      outcome := n::text;
    exception when others then outcome := 'ERROR: ' || sqlerrm;
    end;
    res := res || format('tech updates their own status (rows)|1|%s', outcome);

    begin
      insert into auto_clock_status (staff_id, tracking) values (gen_random_uuid(), true);
      outcome := 'ALLOWED';
    exception when insufficient_privilege then outcome := 'BLOCKED';
    when foreign_key_violation then outcome := 'BLOCKED';
    when others then outcome := 'OTHER ERROR: ' || sqlstate || ' ' || sqlerrm;
    end;
    res := res || format('tech writes a status for someone else|BLOCKED|%s', outcome);

    update auto_clock_status set reason = 'failed' where staff_id = other;
    get diagnostics n = row_count;
    res := res || format('tech changes someone else''s status (rows)|0|%s', n);

    select count(*) into n from auto_clock_status where staff_id in (tech, other);
    res := res || format('tech sees only their own status|1|%s', n);

    begin
      update auto_clock_status set reason = 'sleeping' where staff_id = tech;
      outcome := 'ALLOWED';
    exception when check_violation then outcome := 'BLOCKED';
    when others then outcome := 'OTHER ERROR: ' || sqlstate || ' ' || sqlerrm;
    end;
    res := res || format('unknown reason|BLOCKED|%s', outcome);

    -- ---- As the office -----------------------------------------------------
    perform set_config('request.jwt.claims', json_build_object('sub', off::text, 'role', 'authenticated')::text, true);
    select count(*) into n from auto_clock_status where staff_id in (tech, other);
    res := res || format('office sees everyone''s status|2|%s', n);

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
    raise exception E'% of % scenario(s) FAILED — auto clock status:%',
      n_fail, array_length(res, 1), failures;
  end if;
  raise notice 'all % scenarios passed', array_length(res, 1);
end;
$$;
