-- ============================================================================
-- REGRESSION TEST for 0092 — clock location columns and site pin audit.
--
--   psql "$SUPABASE_DB_URL" -f supabase/tests/0092_clock_location_and_site_pins_test.sql
--   or paste the whole file into the Supabase SQL editor.
-- ============================================================================

do $$
declare
  res text[] := '{}';   -- 'scenario|expected|actual'
  line text;
  parts text[];
  failures text := '';
  n_fail int := 0;
  c text;
begin
  foreach c in array array['clock_in_lat','clock_in_lng','clock_in_accuracy','clock_out_lat','clock_out_lng','clock_out_accuracy'] loop
    res := res || format('signed-in can read time_entries.%s|t|%s', c, has_column_privilege('authenticated', 'public.time_entries', c, 'select'));
  end loop;
  -- 0045's rule still holds.
  res := res || format('rate_override still hidden|f|%s', has_column_privilege('authenticated', 'public.time_entries', 'rate_override', 'select'));
  res := res || format('sites.location_set_at exists|1|%s', (
    select count(*) from information_schema.columns where table_name = 'sites' and column_name = 'location_set_at'));

  foreach line in array res loop
    parts := string_to_array(line, '|');
    if parts[2] is distinct from parts[3] then
      n_fail := n_fail + 1;
      failures := failures || format(E'\n  - %s: expected %s, got %s', parts[1], parts[2], parts[3]);
    end if;
  end loop;
  if n_fail > 0 then
    raise exception E'% of % scenario(s) FAILED — clock location:%',
      n_fail, array_length(res, 1), failures;
  end if;
  raise notice 'all % scenarios passed', array_length(res, 1);
end;
$$;
