-- ============================================================================
-- REGRESSION TEST for 0078 — a shared phone's push token follows whoever is
-- signed in on it.
--
--   psql "$SUPABASE_DB_URL" -f supabase/tests/0078_claim_device_token_test.sql
--   or paste the whole file into the Supabase SQL editor.
--
-- ONE DO BLOCK, SELF-UNDOING — see the 0073 test's header.
-- ============================================================================

do $$
declare
  res text[] := '{}';   -- 'scenario|expected|actual'
  a uuid;
  b uuid;
  tok text := 'ExponentPushToken[test-0078-' || substr(md5(random()::text), 1, 12) || ']';
  outcome text;
  line text;
  parts text[];
  failures text := '';
  n_fail int := 0;
begin
  begin
    select id into a from profiles where role = 'technician' and coalesce(is_active, true) limit 1;
    select id into b from profiles where role in ('office', 'admin') and coalesce(is_active, true)
      order by (role = 'office') desc limit 1;
    if a is null or b is null then
      raise exception 'fixture missing: need an active technician and an office user or admin';
    end if;

    -- 1. A signs in on the phone and claims its token.
    perform set_config('request.jwt.claims', json_build_object('sub', a::text, 'role', 'authenticated')::text, true);
    begin
      perform set_config('role', 'authenticated', true);
      perform claim_device_token(tok, 'ios');
      perform set_config('role', 'postgres', true);
      outcome := 'ALLOWED';
    exception when others then
      perform set_config('role', 'postgres', true);
      outcome := 'BLOCKED';
    end;
    res := res || format('first user claims the token|ALLOWED|%s', outcome);
    res := res || format('token belongs to the first user|%s|%s', a, (select user_id from device_tokens where token = tok));

    -- 2. B signs in on the same phone. The old plain upsert is refused by RLS…
    perform set_config('request.jwt.claims', json_build_object('sub', b::text, 'role', 'authenticated')::text, true);
    begin
      perform set_config('role', 'authenticated', true);
      insert into device_tokens (token, user_id, platform) values (tok, b, 'ios')
        on conflict (token) do update set user_id = excluded.user_id;
      perform set_config('role', 'postgres', true);
      outcome := 'ALLOWED';
    exception when others then
      perform set_config('role', 'postgres', true);
      outcome := 'BLOCKED';
    end;
    res := res || format('old upsert onto another user''s token is refused (the bug)|BLOCKED|%s', outcome);

    -- …and the claim hands the token over.
    begin
      perform set_config('role', 'authenticated', true);
      perform claim_device_token(tok, 'ios');
      perform set_config('role', 'postgres', true);
      outcome := 'ALLOWED';
    exception when others then
      perform set_config('role', 'postgres', true);
      outcome := 'BLOCKED';
    end;
    res := res || format('second user claims the shared phone|ALLOWED|%s', outcome);
    res := res || format('token now belongs to the second user|%s|%s', b, (select user_id from device_tokens where token = tok));
    res := res || format('still exactly one row for the phone|1|%s', (select count(*) from device_tokens where token = tok));

    -- 3. Junk is refused.
    begin
      perform set_config('role', 'authenticated', true);
      perform claim_device_token('not-a-token', 'ios');
      perform set_config('role', 'postgres', true);
      outcome := 'ALLOWED';
    exception when others then
      perform set_config('role', 'postgres', true);
      outcome := 'BLOCKED';
    end;
    res := res || format('a non-Expo token is refused|BLOCKED|%s', outcome);

    -- 4. A deactivated user cannot claim.
    perform set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
    update profiles set is_active = false where id = a;
    perform set_config('request.jwt.claims', json_build_object('sub', a::text, 'role', 'authenticated')::text, true);
    begin
      perform set_config('role', 'authenticated', true);
      perform claim_device_token(tok, 'ios');
      perform set_config('role', 'postgres', true);
      outcome := 'ALLOWED';
    exception when others then
      perform set_config('role', 'postgres', true);
      outcome := 'BLOCKED';
    end;
    res := res || format('a deactivated user cannot claim|BLOCKED|%s', outcome);

    -- 5. Not callable without signing in.
    res := res || format('anon cannot call claim_device_token|false|%s',
      has_function_privilege('anon', 'public.claim_device_token(text, text)', 'execute'));

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
    raise exception E'% of % scenario(s) FAILED — shared-phone push token claim:%',
      n_fail, array_length(res, 1), failures;
  end if;
  raise notice 'all % scenarios passed', array_length(res, 1);
end;
$$;
