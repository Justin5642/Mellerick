-- ============================================================================
-- REGRESSION TEST for 0044 — profiles.role is administrator-only.
--
-- Run against the LIVE database. Everything happens inside a transaction that
-- is ROLLED BACK, so no role is actually changed:
--
--   psql "$SUPABASE_DB_URL" -f supabase/tests/0044_role_escalation_test.sql
--
-- WHAT IT PROTECTS. Every money control in this system reads profiles.role —
-- RLS via is_office_or_admin(), the PowerSync office_* streams, MoneyText /
-- RoleGate in the mobile UI, and requireAdmin / requireOfficeOrAdmin on the web
-- API. Before 0044, `Users can update own profile` was `for update using
-- (auth.uid() = id)` with NO `with check`; Postgres reuses USING for the new
-- row, and `auth.uid() = id` is still true after the role changes. Any
-- technician holding the anon key that ships inside the app could PATCH their
-- own row to role='admin' and clear all four layers at once.
--
-- WHY BOTH HALVES ARE TESTED. A test asserting only that the technician is
-- blocked would pass just as happily if the trigger blocked EVERYONE — which
-- would silently break staff onboarding, since both admin API routes write
-- through the service role where auth.uid() is NULL. The allow cases are not
-- padding; they are the half that catches an over-tight fix.
-- ============================================================================

begin;

create temp table result(scenario text, expected text, actual text) on commit drop;

do $$
declare
  tech uuid;
  adm  uuid;
begin
  select id into tech from profiles where role = 'technician' limit 1;
  select id into adm  from profiles where role = 'admin'      limit 1;
  if tech is null or adm is null then
    raise exception 'fixture missing: need at least one technician and one admin';
  end if;

  -- 1. THE ATTACK. A technician, authenticated exactly as PostgREST would
  --    present them, promoting themselves.
  perform set_config('request.jwt.claims',
                     json_build_object('sub', tech::text, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
  begin
    update profiles set role = 'admin' where id = tech;
    perform set_config('role', 'postgres', true);
    insert into result values ('technician self-promotes', 'BLOCKED', 'ALLOWED');
  exception when others then
    perform set_config('role', 'postgres', true);
    insert into result values ('technician self-promotes', 'BLOCKED', 'BLOCKED');
  end;

  -- 2. A technician editing a NON-role field must still work. The fix must
  --    restrict one column, not lock people out of their own profile.
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

  -- 3. The service role — what app/api/staff/invite and /staff/update use, both
  --    admin-gated at the API layer. auth.uid() is NULL here, so is_admin()
  --    alone would have blocked all staff onboarding.
  perform set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
  begin
    update profiles set role = 'office' where id = tech;
    insert into result values ('service_role changes role', 'ALLOWED', 'ALLOWED');
  exception when others then
    insert into result values ('service_role changes role', 'ALLOWED', 'BLOCKED');
  end;

  -- 4. An admin acting directly with their own JWT.
  perform set_config('request.jwt.claims',
                     json_build_object('sub', adm::text, 'role', 'authenticated')::text, true);
  begin
    update profiles set role = 'office' where id = tech;
    insert into result values ('admin changes role', 'ALLOWED', 'ALLOWED');
  exception when others then
    insert into result values ('admin changes role', 'ALLOWED', 'BLOCKED');
  end;

  -- 5. New self-registered accounts cannot choose their own role.
  if position('invited_at' in pg_get_functiondef('public.handle_new_user'::regproc)) > 0 then
    insert into result values ('signup metadata role ignored', 'gated', 'gated');
  else
    insert into result values ('signup metadata role ignored', 'gated', 'NOT GATED');
  end if;
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
    raise exception '% scenario(s) FAILED — profiles.role is not properly protected', failures;
  end if;
  raise notice 'all scenarios passed';
end;
$$;

rollback;
