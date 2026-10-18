-- ============================================================================
-- REGRESSION TEST for 0075 — OAuth tokens are server-only.
--
--   psql "$SUPABASE_DB_URL" -f supabase/tests/0075_oauth_tokens_server_only_test.sql
--   or paste the whole file into the Supabase SQL editor.
--
-- ONE DO BLOCK, SELF-UNDOING — see the 0073 test's header.
--
-- An office user (who passes 0042's RLS policy) must not be able to read the
-- refresh token, or write the row, with their own JWT — while still being able
-- to read the connection status the Settings page shows.
-- ============================================================================

do $$
declare
  res text[] := '{}';   -- 'scenario|expected|actual'
  off uuid;
  sc record;
  outcome text;
  line text;
  parts text[];
  failures text := '';
  n_fail int := 0;
begin
  begin
    -- Prefer an office user; fall back to an admin when the database has none
    -- (production has no office-role staff). Admins pass the same
    -- is_office_or_admin() checks, so every assertion means the same thing.
    select id into off from profiles where role in ('office', 'admin') and coalesce(is_active, true)
      order by (role = 'office') desc limit 1;
    if off is null then
      raise exception 'fixture missing: need an active office user or admin';
    end if;

    -- A token row to aim at, in case the integration is not connected.
    perform set_config('request.jwt.claims', '', true);
    insert into xero_tokens (access_token, refresh_token, token_expiry, tenant_name)
      values ('a', 'r', now() + interval '1 hour', 'CI Org');

    perform set_config('request.jwt.claims',
                       json_build_object('sub', off::text, 'role', 'authenticated')::text, true);
    for sc in
      select * from (values
        (1, 'office reads xero refresh_token', 'BLOCKED', 'select refresh_token from xero_tokens'),
        (2, 'office reads google access_token', 'BLOCKED', 'select access_token from google_tokens'),
        (3, 'office repoints the Xero org', 'BLOCKED', $q$update xero_tokens set tenant_id = 'attacker-org'$q$),
        (4, 'office reads connection status', 'ALLOWED', 'select tenant_name, updated_at from xero_tokens')
      ) v(ord, scenario, expected, stmt)
      order by ord
    loop
      begin
        perform set_config('role', 'authenticated', true);
        execute sc.stmt;
        perform set_config('role', 'postgres', true);
        outcome := 'ALLOWED';
      exception when others then
        perform set_config('role', 'postgres', true);
        outcome := 'BLOCKED';
      end;
      res := res || format('%s|%s|%s', sc.scenario, sc.expected, outcome);
    end loop;

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
    if parts[2] is distinct from parts[3] then
      n_fail := n_fail + 1;
      failures := failures || format(E'\n  - %s: expected %s, got %s', parts[1], parts[2], parts[3]);
    end if;
  end loop;
  if n_fail > 0 then
    raise exception E'% of % scenario(s) FAILED — OAuth tokens are readable or writable by clients:%',
      n_fail, array_length(res, 1), failures;
  end if;
  raise notice 'all % scenarios passed', array_length(res, 1);
end;
$$;
