-- ============================================================================
-- REGRESSION TEST for 0098 — the Xero analytics mirror.
--
--   psql "$SUPABASE_DB_URL" -f supabase/tests/0098_xero_analytics_test.sql
--   or paste the whole file into the Supabase SQL editor.
--
-- ONE DO BLOCK, SELF-UNDOING — see the 0073 test's header. It asserts the END
-- STATE (a policy that "looks right" is not proof): RLS on, one office/admin
-- SELECT policy, anon has nothing, signed-in users cannot write, and the
-- service role can. It raises on any failure.
-- ============================================================================

do $$
declare
  t text;
  n int;
  failures text := '';
begin
  foreach t in array array['xero_invoices', 'xero_payments', 'xero_pl_monthly', 'xero_sync_state'] loop
    if not (select relrowsecurity from pg_class where oid = ('public.' || t)::regclass) then
      failures := failures || format('%s: RLS is off; ', t);
    end if;

    select count(*) into n from pg_policy where polrelid = ('public.' || t)::regclass;
    if n <> 1 then
      failures := failures || format('%s: expected exactly 1 policy, found %s; ', t, n);
    end if;

    if has_table_privilege('anon', 'public.' || t, 'select') then
      failures := failures || format('%s: anon can SELECT; ', t);
    end if;
    if has_table_privilege('authenticated', 'public.' || t, 'insert')
       or has_table_privilege('authenticated', 'public.' || t, 'update')
       or has_table_privilege('authenticated', 'public.' || t, 'delete') then
      failures := failures || format('%s: signed-in users can write; ', t);
    end if;
    if not has_table_privilege('authenticated', 'public.' || t, 'select') then
      failures := failures || format('%s: signed-in users cannot SELECT (RLS then returns nothing silently — the 0088 trap); ', t);
    end if;
    if not has_table_privilege('service_role', 'public.' || t, 'insert') then
      failures := failures || format('%s: service role cannot write; ', t);
    end if;
  end loop;

  if failures <> '' then
    raise exception '0098 gate FAILED: %', failures;
  end if;
  raise notice '0098 gate passed: 4 tables, RLS on, one office/admin read policy each, writes service-role only';
end $$;
