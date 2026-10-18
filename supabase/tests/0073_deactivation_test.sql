-- ============================================================================
-- REGRESSION TEST for 0073 — deactivated staff lose access; the "_public"
-- views refuse anon.
--
--   psql "$SUPABASE_DB_URL" -f supabase/tests/0073_deactivation_test.sql
--   or paste the whole file into the Supabase SQL editor.
--
-- ONE DO BLOCK, SELF-UNDOING. The Supabase SQL editor does not hold an
-- explicit BEGIN … ROLLBACK open across statements, so the earlier
-- "temp table + rollback" shape lost its table the moment it was created
-- (relation "result" does not exist). Everything now runs inside a single DO
-- block: the fixture changes and scenarios sit in an inner block that ends by
-- raising a private SQLSTATE, which rolls that inner block back, and the
-- results — kept in a local variable, which survives the rollback — are
-- reported afterwards. Success prints nothing; a failure raises and names
-- each failing scenario.
--
-- Both halves are tested, as in 0044: the attack must be blocked AND the
-- legitimate admin / service-role path must still work, or staff management
-- breaks silently.
-- ============================================================================

do $$
declare
  res text[] := '{}';   -- 'scenario|expected|actual'
  tech uuid;
  adm  uuid;
  off  uuid;
  outcome text;
  line text;
  parts text[];
  failures text := '';
  n_fail int := 0;
begin
  begin
    select id into tech from profiles where role = 'technician' limit 1;
    select id into adm  from profiles where role = 'admin' and coalesce(is_active, true) limit 1;
    -- Prefer an office user; fall back to an admin when the database has none
    -- (production has no office-role staff). Admins pass the same
    -- is_office_or_admin() checks, so every assertion means the same thing.
    select id into off  from profiles where role in ('office', 'admin') and coalesce(is_active, true)
      order by (role = 'office') desc limit 1;
    if tech is null or adm is null or off is null then
      raise exception 'fixture missing: need a technician and an office user or admin';
    end if;

    -- Fixture writes go through the service role: 0073's trigger refuses an
    -- is_active change from anyone else, which is the point.
    perform set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);

    -- 1. A deactivated office/admin user no longer passes is_office_or_admin.
    update profiles set is_active = false where id = off;
    res := res || format('inactive office/admin user passes is_office_or_admin|false|%s', is_office_or_admin(off));
    update profiles set is_active = true where id = off;
    res := res || format('active office/admin user passes is_office_or_admin|true|%s', is_office_or_admin(off));

    -- 2. THE ATTACK: a deactivated technician reactivates themselves.
    update profiles set is_active = false where id = tech;
    perform set_config('request.jwt.claims',
                       json_build_object('sub', tech::text, 'role', 'authenticated')::text, true);
    begin
      perform set_config('role', 'authenticated', true);
      update profiles set is_active = true where id = tech;
      perform set_config('role', 'postgres', true);
      outcome := 'ALLOWED';
    exception when others then
      perform set_config('role', 'postgres', true);
      outcome := 'BLOCKED';
    end;
    res := res || format('technician reactivates self|BLOCKED|%s', outcome);

    -- 3. A technician editing a non-privileged field still works.
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

    -- 4. The service role (what /api/staff/set-active uses) can flip it.
    perform set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
    begin
      update profiles set is_active = true where id = tech;
      outcome := 'ALLOWED';
    exception when others then
      outcome := 'BLOCKED';
    end;
    res := res || format('service_role reactivates|ALLOWED|%s', outcome);

    -- 5. An active admin with their own JWT can flip it.
    perform set_config('request.jwt.claims',
                       json_build_object('sub', adm::text, 'role', 'authenticated')::text, true);
    begin
      update profiles set is_active = false where id = tech;
      outcome := 'ALLOWED';
    exception when others then
      outcome := 'BLOCKED';
    end;
    res := res || format('admin deactivates|ALLOWED|%s', outcome);

    -- 6. The money-free views refuse anon and serve authenticated.
    res := res || format('anon reads job_variations_public|false|%s',
      has_table_privilege('anon', 'public.job_variations_public', 'select'));
    res := res || format('anon reads purchase_orders_public|false|%s',
      has_table_privilege('anon', 'public.purchase_orders_public', 'select'));
    res := res || format('authenticated reads purchase_orders_public|true|%s',
      has_table_privilege('authenticated', 'public.purchase_orders_public', 'select'));

    -- Undo every change above. Only `res` (a variable) survives.
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
    raise exception E'% of % scenario(s) FAILED — deactivation / view grants not in force:%',
      n_fail, array_length(res, 1), failures;
  end if;
  raise notice 'all % scenarios passed', array_length(res, 1);
end;
$$;
