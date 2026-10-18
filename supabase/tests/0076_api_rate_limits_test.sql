-- ============================================================================
-- REGRESSION TEST for 0076 (DRAFT — NOT APPLIED to production) — the shared
-- per-user rate limit for the AI routes counts correctly, rolls over, keeps
-- users and buckets apart, and is unreachable via PostgREST.
--
--   psql "$SUPABASE_DB_URL" -f supabase/tests/0076_api_rate_limits_test.sql
--   or paste the whole file into the Supabase SQL editor.
--
-- ONE DO BLOCK, SELF-UNDOING — see the 0073 test's header.
--
-- Time is simulated by moving window_start into the past, same approach as the
-- 0055/0056 lockout tests.
-- ============================================================================

do $$
declare
  res text[] := '{}';   -- 'scenario|expected|actual'
  uid uuid;
  other uuid;
  allowed boolean;
  outcome text;
  i int;
  line text;
  parts text[];
  failures text := '';
  n_fail int := 0;
begin
  begin
    select id into uid from profiles order by id limit 1;
    select id into other from profiles where id <> uid order by id limit 1;
    if uid is null or other is null then
      raise exception 'fixture missing: need two profiles (supabase/ci/seed-roles.sql seeds them)';
    end if;

    delete from public.api_rate_limits where user_id in (uid, other);

    -- 3 per 60s: requests 1-3 allowed, 4th refused.
    for i in 1..3 loop
      select public.consume_rate_limit(uid, 'test-bucket', 3, 60) into allowed;
      res := res || format('request %s within limit|true|%s', i, allowed);
    end loop;

    select public.consume_rate_limit(uid, 'test-bucket', 3, 60) into allowed;
    res := res || format('request 4 refused|false|%s', allowed);

    -- Another user, and another bucket for the same user, are counted separately.
    select public.consume_rate_limit(other, 'test-bucket', 3, 60) into allowed;
    res := res || format('other user has their own allowance|true|%s', allowed);
    select public.consume_rate_limit(uid, 'other-bucket', 3, 60) into allowed;
    res := res || format('other bucket has its own allowance|true|%s', allowed);

    -- Window rolls over: count restarts at 1.
    update public.api_rate_limits
      set window_start = now() - interval '61 seconds'
      where user_id = uid and bucket = 'test-bucket';
    select public.consume_rate_limit(uid, 'test-bucket', 3, 60) into allowed;
    res := res || format('allowed again after window elapses|true|%s', allowed);
    res := res || format('count reset to 1 after rollover|1|%s',
      (select request_count from public.api_rate_limits where user_id = uid and bucket = 'test-bucket'));

    -- PostgREST exposure: authenticated must not call the function or read the table.
    perform set_config('request.jwt.claims', json_build_object('sub', uid::text, 'role', 'authenticated')::text, true);

    begin
      perform set_config('role', 'authenticated', true);
      perform public.consume_rate_limit(uid, 'test-bucket', 3, 60);
      perform set_config('role', 'postgres', true);
      outcome := 'CALLABLE';
    exception when insufficient_privilege then
      perform set_config('role', 'postgres', true);
      outcome := 'BLOCKED';
    end;
    res := res || format('authenticated cannot call consume_rate_limit|BLOCKED|%s', outcome);

    begin
      perform set_config('role', 'authenticated', true);
      perform 1 from public.api_rate_limits limit 1;
      perform set_config('role', 'postgres', true);
      outcome := 'READABLE';
    exception when insufficient_privilege then
      perform set_config('role', 'postgres', true);
      outcome := 'BLOCKED';
    end;
    res := res || format('authenticated cannot read api_rate_limits|BLOCKED|%s', outcome);

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
    raise exception E'% of % scenario(s) FAILED -- shared API rate limit has regressed:%',
      n_fail, array_length(res, 1), failures;
  end if;
  raise notice 'all % scenarios passed', array_length(res, 1);
end;
$$;
