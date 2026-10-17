-- ============================================================================
-- REGRESSION TEST for 0076 (DRAFT — NOT APPLIED to production) — the shared
-- per-user rate limit for the AI routes counts correctly, rolls over, keeps
-- users and buckets apart, and is unreachable via PostgREST.
--
-- Everything runs inside a transaction that is ROLLED BACK:
--
--   psql "$SUPABASE_DB_URL" -f supabase/tests/0076_api_rate_limits_test.sql
--
-- Time is simulated by moving window_start into the past, same approach as the
-- 0055/0056 lockout tests.
-- ============================================================================

begin;

create temp table r(scenario text, expected text, actual text) on commit drop;

do $$
declare
  uid uuid;
  other uuid;
  allowed boolean;
  outcome text;
  i int;
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
    if not allowed then
      insert into r values (format('request %s within limit', i), 'true', 'false');
    end if;
  end loop;
  insert into r values ('requests 1-3 allowed', 'true', 'true');

  select public.consume_rate_limit(uid, 'test-bucket', 3, 60) into allowed;
  insert into r values ('request 4 refused', 'false', allowed::text);

  -- Another user, and another bucket for the same user, are counted separately.
  select public.consume_rate_limit(other, 'test-bucket', 3, 60) into allowed;
  insert into r values ('other user has their own allowance', 'true', allowed::text);
  select public.consume_rate_limit(uid, 'other-bucket', 3, 60) into allowed;
  insert into r values ('other bucket has its own allowance', 'true', allowed::text);

  -- Window rolls over: count restarts at 1.
  update public.api_rate_limits
    set window_start = now() - interval '61 seconds'
    where user_id = uid and bucket = 'test-bucket';
  select public.consume_rate_limit(uid, 'test-bucket', 3, 60) into allowed;
  insert into r values ('allowed again after window elapses', 'true', allowed::text);
  insert into r values (
    'count reset to 1 after rollover',
    '1',
    (select request_count::text from public.api_rate_limits where user_id = uid and bucket = 'test-bucket')
  );

  -- PostgREST exposure: authenticated must not call the function or read the
  -- table. Outcome captured in a variable and written after switching back —
  -- `authenticated` has no privilege on the temp table either (see 0056 test).
  perform set_config('request.jwt.claims', json_build_object('sub', uid::text, 'role', 'authenticated')::text, true);

  perform set_config('role', 'authenticated', true);
  begin
    perform public.consume_rate_limit(uid, 'test-bucket', 3, 60);
    outcome := 'CALLABLE';
  exception when insufficient_privilege then
    outcome := 'BLOCKED';
  end;
  perform set_config('role', 'postgres', true);
  insert into r values ('authenticated cannot call consume_rate_limit', 'BLOCKED', outcome);

  perform set_config('role', 'authenticated', true);
  begin
    perform 1 from public.api_rate_limits limit 1;
    outcome := 'READABLE';
  exception when insufficient_privilege then
    outcome := 'BLOCKED';
  end;
  perform set_config('role', 'postgres', true);
  insert into r values ('authenticated cannot read api_rate_limits', 'BLOCKED', outcome);

  delete from public.api_rate_limits where user_id in (uid, other);
end $$;

select coalesce(json_agg(row_to_json(t)), '[]'::json)::text from (
  select scenario, actual, case when expected = actual then 'PASS' else '*** FAIL ***' end as verdict
  from r
) t;

do $$
declare failures int;
begin
  select count(*) into failures from r where expected <> actual;
  if failures > 0 then
    raise exception '% scenario(s) FAILED -- shared API rate limit has regressed', failures;
  end if;
  raise notice 'all scenarios passed';
end;
$$;

rollback;
