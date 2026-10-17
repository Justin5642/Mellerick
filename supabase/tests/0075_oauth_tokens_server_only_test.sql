-- ============================================================================
-- REGRESSION TEST for 0075 — OAuth tokens are server-only.
--
--   psql "$SUPABASE_DB_URL" -f supabase/tests/0075_oauth_tokens_server_only_test.sql
--
-- An office user (who passes 0042's RLS policy) must not be able to read the
-- refresh token, or write the row, with their own JWT — while still being able
-- to read the connection status the Settings page shows. Rolled back.
-- ============================================================================

begin;

create temp table result(scenario text, expected text, actual text) on commit drop;

do $$
declare
  off uuid;
begin
  select id into off from profiles where role = 'office' and coalesce(is_active, true) limit 1;
  if off is null then
    raise exception 'fixture missing: need an active office user';
  end if;

  perform set_config('request.jwt.claims', '', true);
  insert into xero_tokens (access_token, refresh_token, token_expiry, tenant_name)
    values ('a', 'r', now() + interval '1 hour', 'CI Org');

  perform set_config('request.jwt.claims',
                     json_build_object('sub', off::text, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);

  begin
    perform refresh_token from xero_tokens limit 1;
    insert into result values ('office reads xero refresh_token', 'BLOCKED', 'ALLOWED');
  exception when insufficient_privilege then
    insert into result values ('office reads xero refresh_token', 'BLOCKED', 'BLOCKED');
  end;

  begin
    perform access_token from google_tokens limit 1;
    insert into result values ('office reads google access_token', 'BLOCKED', 'ALLOWED');
  exception when insufficient_privilege then
    insert into result values ('office reads google access_token', 'BLOCKED', 'BLOCKED');
  end;

  begin
    update xero_tokens set tenant_id = 'attacker-org';
    insert into result values ('office repoints the Xero org', 'BLOCKED', 'ALLOWED');
  exception when insufficient_privilege then
    insert into result values ('office repoints the Xero org', 'BLOCKED', 'BLOCKED');
  end;

  begin
    perform tenant_name from xero_tokens limit 1;
    insert into result values ('office reads connection status', 'ALLOWED', 'ALLOWED');
  exception when others then
    insert into result values ('office reads connection status', 'ALLOWED', 'BLOCKED');
  end;

  perform set_config('role', 'postgres', true);
end;
$$;

select scenario, expected, actual,
       case when expected = actual then 'PASS' else '*** FAIL ***' end as verdict
from result;

do $$
declare failures int;
begin
  select count(*) into failures from result where expected <> actual;
  if failures > 0 then
    raise exception '% scenario(s) FAILED — OAuth tokens are readable or writable by clients', failures;
  end if;
  raise notice 'all scenarios passed';
end;
$$;

rollback;
