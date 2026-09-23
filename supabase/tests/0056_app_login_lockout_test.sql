-- ============================================================================
-- REGRESSION TEST for 0056 -- the app-level lockout fallback (check/record/
-- clear) matches the same 6-in-a-row / 10 minute policy as 0055's hook, and
-- is unreachable via PostgREST by anon/authenticated.
--
-- Run against the LIVE database; everything is inside a transaction that is
-- ROLLED BACK, so nothing is modified:
--
--   psql "$SUPABASE_DB_URL" -f supabase/tests/0056_app_login_lockout_test.sql
--
-- Calls the three functions directly rather than hitting the API route, so
-- this runs in milliseconds and needs no live app. Time is simulated by
-- moving `first_failed_at`/`locked_until` into the past rather than sleeping
-- for 10 real minutes -- same approach as 0055's test.
-- ============================================================================

begin;

create temp table r(scenario text, expected text, actual text) on commit drop;

do $$
declare
  uid uuid;
  locked boolean;
  msg text;
  outcome text;
  i int;
begin
  select id into uid from profiles limit 1;

  delete from public.login_lockouts where user_id = uid;

  -- Not locked to start.
  select (hr->>'locked')::boolean into locked from public.check_login_lockout(uid) hr;
  insert into r values ('fresh user: not locked', 'false', locked::text);

  -- Failures 1-5: record_login_failure must all report not-locked.
  for i in 1..5 loop
    select (hr->>'locked')::boolean into locked from public.record_login_failure(uid) hr;
    if locked then
      insert into r values (format('failure %s should not lock', i), 'false', 'true');
    end if;
  end loop;
  insert into r values ('failures 1-5 all report not locked', 'false', 'false');

  -- Failure 6: locks, with a message.
  select (hr->>'locked')::boolean, hr->>'message' into locked, msg from public.record_login_failure(uid) hr;
  insert into r values ('failure 6 locks', 'true', locked::text);
  insert into r values ('lock message mentions "Forgot password"', 'PASS', case when msg like '%Forgot password%' then 'PASS' else 'FAIL (' || coalesce(msg, 'null') || ')' end);

  -- check_login_lockout mid-lockout must also report locked -- this is what
  -- the API route checks BEFORE attempting signInWithPassword at all.
  select (hr->>'locked')::boolean into locked from public.check_login_lockout(uid) hr;
  insert into r values ('check reports locked mid-lockout', 'true', locked::text);

  -- Simulate the 10 minute cooldown elapsing.
  update public.login_lockouts
    set locked_until = now() - interval '1 second',
        first_failed_at = now() - interval '11 minutes'
    where user_id = uid;

  select (hr->>'locked')::boolean into locked from public.check_login_lockout(uid) hr;
  insert into r values ('check reports not locked after cooldown elapses', 'false', locked::text);

  -- Post-cooldown, another failure: must be a fresh count of 1, not locked.
  select (hr->>'locked')::boolean into locked from public.record_login_failure(uid) hr;
  insert into r values ('failure after cooldown does not lock (fresh window)', 'false', locked::text);
  select failed_count::text into msg from public.login_lockouts where user_id = uid;
  insert into r values ('failed_count reset to 1 after cooldown, not 7', '1', msg);

  -- clear_login_lockout removes the row entirely.
  perform public.clear_login_lockout(uid);
  insert into r values (
    'clear_login_lockout removes the row',
    '0',
    (select count(*)::text from public.login_lockouts where user_id = uid)
  );

  -- PostgREST exposure check: authenticated must NOT be able to call any of
  -- the three functions directly -- the same 0054 pitfall this whole file is
  -- guarding against, now for three functions instead of one. Note: while
  -- impersonating `authenticated`, this session also loses privilege on the
  -- temp table `r` (owned by postgres, no grants to authenticated) -- so the
  -- outcome is captured in a variable and only written to `r` after
  -- switching back to postgres, same pattern as 0055's test.
  perform set_config('request.jwt.claims', json_build_object('sub', uid::text, 'role', 'authenticated')::text, true);

  perform set_config('role', 'authenticated', true);
  begin
    perform public.check_login_lockout(uid);
    outcome := 'CALLABLE';
  exception when insufficient_privilege then
    outcome := 'BLOCKED';
  end;
  perform set_config('role', 'postgres', true);
  insert into r values ('authenticated cannot call check_login_lockout', 'BLOCKED', outcome);

  perform set_config('role', 'authenticated', true);
  begin
    perform public.record_login_failure(uid);
    outcome := 'CALLABLE';
  exception when insufficient_privilege then
    outcome := 'BLOCKED';
  end;
  perform set_config('role', 'postgres', true);
  insert into r values ('authenticated cannot call record_login_failure', 'BLOCKED', outcome);

  perform set_config('role', 'authenticated', true);
  begin
    perform public.clear_login_lockout(uid);
    outcome := 'CALLABLE';
  exception when insufficient_privilege then
    outcome := 'BLOCKED';
  end;
  perform set_config('role', 'postgres', true);
  insert into r values ('authenticated cannot call clear_login_lockout', 'BLOCKED', outcome);

  delete from public.login_lockouts where user_id = uid;
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
    raise exception '% scenario(s) FAILED -- app-level login lockout behaviour has regressed', failures;
  end if;
  raise notice 'all scenarios passed';
end;
$$;

rollback;
