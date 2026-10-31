-- ============================================================================
-- REGRESSION TEST for 0088 — grants on cost_centres and suppliers.
--
--   psql "$SUPABASE_DB_URL" -f supabase/tests/0088_grant_cost_centres_and_suppliers_test.sql
--   or paste the whole file into the Supabase SQL editor.
-- ============================================================================

do $$
declare
  res text[] := '{}';   -- 'scenario|expected|actual'
  line text;
  parts text[];
  failures text := '';
  n_fail int := 0;
begin
  res := res || format('signed-in can read cost centres|t|%s', has_table_privilege('authenticated', 'public.cost_centres', 'select'));
  res := res || format('signed-in can add cost centres (RLS decides who)|t|%s', has_table_privilege('authenticated', 'public.cost_centres', 'insert'));
  res := res || format('signed-in can read suppliers (RLS: office/admin)|t|%s', has_table_privilege('authenticated', 'public.suppliers', 'select'));
  res := res || format('service role can write suppliers|t|%s', has_table_privilege('service_role', 'public.suppliers', 'insert'));
  res := res || format('anon cannot read cost centres|f|%s', has_table_privilege('anon', 'public.cost_centres', 'select'));
  res := res || format('anon cannot read suppliers|f|%s', has_table_privilege('anon', 'public.suppliers', 'select'));
  res := res || format('cost centres RLS still on|t|%s', (select relrowsecurity from pg_class where oid = 'public.cost_centres'::regclass));
  res := res || format('suppliers RLS still on|t|%s', (select relrowsecurity from pg_class where oid = 'public.suppliers'::regclass));
  res := res || format('active cost centres|4+|%s', case when (select count(*) from cost_centres where is_active) >= 4 then '4+' else (select count(*)::text from cost_centres where is_active) end);

  foreach line in array res loop
    parts := string_to_array(line, '|');
    if parts[2] is distinct from parts[3] then
      n_fail := n_fail + 1;
      failures := failures || format(E'\n  - %s: expected %s, got %s', parts[1], parts[2], parts[3]);
    end if;
  end loop;
  if n_fail > 0 then
    raise exception E'% of % scenario(s) FAILED — cost centre grants:%',
      n_fail, array_length(res, 1), failures;
  end if;
  raise notice 'all % scenarios passed', array_length(res, 1);
end;
$$;
