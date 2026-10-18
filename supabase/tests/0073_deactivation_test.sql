-- ============================================================================
-- REGRESSION TEST for 0073 — deactivated staff lose access; the "_public"
-- views refuse anon.
--
-- Everything happens inside a transaction that is ROLLED BACK:
--
--   psql "$SUPABASE_DB_URL" -f supabase/tests/0073_deactivation_test.sql
--
-- Both halves are tested, as in 0044: the attack must be blocked AND the
-- legitimate admin / service-role path must still work, or staff management
-- breaks silently.
-- ============================================================================

begin;

create temp table result(scenario text, expected text, actual text) on commit drop;

do $$
declare
  tech uuid;
  adm  uuid;
  off  uuid;
begin
  select id into tech from profiles where role = 'technician' limit 1;
  select id into adm  from profiles where role = 'admin'      limit 1;
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

  -- 1. A deactivated office user is no longer office-or-admin.
  update profiles set is_active = false where id = off;
  insert into result values ('inactive office user passes is_office_or_admin', 'false',
                             is_office_or_admin(off)::text);
  update profiles set is_active = true where id = off;
  insert into result values ('active office user passes is_office_or_admin', 'true',
                             is_office_or_admin(off)::text);

  -- 2. THE ATTACK: a deactivated technician reactivates themselves.
  perform set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
  update profiles set is_active = false where id = tech;
  perform set_config('request.jwt.claims',
                     json_build_object('sub', tech::text, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
  begin
    update profiles set is_active = true where id = tech;
    perform set_config('role', 'postgres', true);
    insert into result values ('technician reactivates self', 'BLOCKED', 'ALLOWED');
  exception when others then
    perform set_config('role', 'postgres', true);
    insert into result values ('technician reactivates self', 'BLOCKED', 'BLOCKED');
  end;

  -- 3. A technician editing a non-privileged field still works.
  perform set_config('request.jwt.claims',
                     json_build_object('sub', tech::text, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
  begin
    update profiles set full_name = full_name where id = tech;
    perform set_config('role', 'postgres', true);
    insert into result values ('technician edits own name', 'ALLOWED', 'ALLOWED');
  exception when others then
    perform set_config('role', 'postgres', true);
    insert into result values ('technician edits own name', 'ALLOWED', 'BLOCKED');
  end;

  -- 4. The service role (what /api/staff/set-active uses) can flip it.
  perform set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
  begin
    update profiles set is_active = true where id = tech;
    insert into result values ('service_role reactivates', 'ALLOWED', 'ALLOWED');
  exception when others then
    insert into result values ('service_role reactivates', 'ALLOWED', 'BLOCKED');
  end;

  -- 5. An active admin with their own JWT can flip it.
  perform set_config('request.jwt.claims',
                     json_build_object('sub', adm::text, 'role', 'authenticated')::text, true);
  begin
    update profiles set is_active = false where id = tech;
    insert into result values ('admin deactivates', 'ALLOWED', 'ALLOWED');
  exception when others then
    insert into result values ('admin deactivates', 'ALLOWED', 'BLOCKED');
  end;

  -- 6. The money-free views refuse anon and serve authenticated.
  insert into result values ('anon reads job_variations_public', 'false',
    has_table_privilege('anon', 'public.job_variations_public', 'select')::text);
  insert into result values ('anon reads purchase_orders_public', 'false',
    has_table_privilege('anon', 'public.purchase_orders_public', 'select')::text);
  insert into result values ('authenticated reads purchase_orders_public', 'true',
    has_table_privilege('authenticated', 'public.purchase_orders_public', 'select')::text);
end;
$$;

select scenario,
       expected,
       actual,
       case when expected = actual then 'PASS' else '*** FAIL ***' end as verdict
from result;

do $$
declare failures int;
begin
  select count(*) into failures from result where expected <> actual;
  if failures > 0 then
    raise exception '% scenario(s) FAILED — deactivation / view grants not in force', failures;
  end if;
  raise notice 'all scenarios passed';
end;
$$;

rollback;
