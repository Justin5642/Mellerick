-- ============================================================================
-- REGRESSION TEST for 0094 — per-site clock-on fence size.
--
--   psql "$SUPABASE_DB_URL" -f supabase/tests/0094_site_fence_size_test.sql
--   or paste the whole file into the Supabase SQL editor.
--
-- ONE DO BLOCK, SELF-UNDOING — see the 0073 test's header.
-- ============================================================================

do $$
declare
  res text[] := '{}';   -- 'scenario|expected|actual'
  s uuid;
  outcome text;
  line text;
  parts text[];
  failures text := '';
  n_fail int := 0;
begin
  begin
    res := res || format('signed-in can read sites.geofence_radius_m|t|%s',
      has_column_privilege('authenticated', 'public.sites', 'geofence_radius_m', 'select'));

    select id into s from sites limit 1;
    if s is null then
      raise exception 'fixture missing: need a site';
    end if;

    update sites set geofence_radius_m = 400 where id = s;
    res := res || format('a 400 m fence saves|400|%s', (select geofence_radius_m from sites where id = s));
    update sites set geofence_radius_m = null where id = s;
    res := res || format('back to standard|t|%s', (select geofence_radius_m is null from sites where id = s));

    begin
      update sites set geofence_radius_m = 20 where id = s;
      outcome := 'ALLOWED';
    exception when check_violation then
      outcome := 'BLOCKED';
    end;
    res := res || format('20 m fence|BLOCKED|%s', outcome);
    begin
      update sites set geofence_radius_m = 5000 where id = s;
      outcome := 'ALLOWED';
    exception when check_violation then
      outcome := 'BLOCKED';
    end;
    res := res || format('5 km fence|BLOCKED|%s', outcome);

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
    raise exception E'% of % scenario(s) FAILED — site fence size:%',
      n_fail, array_length(res, 1), failures;
  end if;
  raise notice 'all % scenarios passed', array_length(res, 1);
end;
$$;
