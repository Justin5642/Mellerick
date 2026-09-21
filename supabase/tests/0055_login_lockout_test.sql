-- ============================================================================
-- REGRESSION TEST for 0055 — password lockout is 6-in-a-row / 10 minutes,
-- not the old one-or-two-strikes / hour, and cannot be bypassed by finally
-- guessing right mid-lockout.
--
-- Run against the LIVE database; everything is inside a transaction that is
-- ROLLED BACK, so nothing is modified:
--
--   psql "$SUPABASE_DB_URL" -f supabase/tests/0055_login_lockout_test.sql
--
-- Calls hook_password_verification_attempt() directly rather than actually
-- failing real logins 6 times, so this runs in milliseconds and needs no
-- live app. Time is simulated by moving `first_failed_at`/`locked_until`
-- into the past rather than sleeping for 10 real minutes.
--
-- NOTE ON ROLE IMPERSONATION: unlike local dev (where `postgres` is a true
-- superuser and `SET ROLE` works to anything), on a hosted Supabase project
-- `postgres` is deliberately NOT a member of `supabase_auth_admin` — the
-- role GoTrue actually runs this hook as — so this test cannot literally
-- SET ROLE to it here (confirmed: pg_has_role('postgres',
-- 'supabase_auth_admin', 'member') = false on this project, vs. true for
-- anon/authenticated/service_role). Instead the hook is called directly as
-- `postgres`, which owns the function and therefore bypasses its EXECUTE
-- grant check entirely (Postgres object owners always implicitly have every
-- privilege on their own objects) — so this still exercises the exact same
-- function body/logic supabase_auth_admin would run. That supabase_auth_admin
-- specifically holds the EXECUTE/table grants it needs is asserted
-- separately, inside migration 0055 itself, right after the grants are made.
-- The one impersonation this file still does for real is `authenticated`,
-- below, for the PostgREST-exposure check — postgres IS a member of that
-- role on hosted Supabase, so `SET ROLE` to it genuinely works.
-- ============================================================================

begin;

create temp table r(scenario text, expected text, actual text) on commit drop;

do $$
declare
  uid uuid;
  decision text;
  msg text;
  outcome text;
  i int;
begin
  select id into uid from profiles limit 1;

  -- Clean slate for this user (belt and braces — should already be absent).
  delete from public.login_lockouts where user_id = uid;

  -- Attempts 1-5: wrong password, must all continue.
  for i in 1..5 loop
    select hr->>'decision' into decision
    from public.hook_password_verification_attempt(
      jsonb_build_object('user_id', uid, 'valid', false)
    ) hr;
    if decision <> 'continue' then
      insert into r values (format('attempt %s (wrong password)', i), 'continue', decision);
    end if;
  end loop;
  insert into r values ('attempts 1-5 (wrong password) all continued', 'continue', 'continue');

  -- Attempt 6: the lock. Must reject, and say so.
  select hr->>'decision', hr->>'message' into decision, msg
  from public.hook_password_verification_attempt(
    jsonb_build_object('user_id', uid, 'valid', false)
  ) hr;
  insert into r values ('attempt 6 (wrong password) locks', 'reject', decision);
  insert into r values ('lock message mentions "Forgot password"', 'PASS', case when msg like '%Forgot password%' then 'PASS' else 'FAIL (' || coalesce(msg, 'null') || ')' end);

  -- Attempt 7, CORRECT password, still inside the cooldown: must still
  -- reject. This is the check that would fail if the lockout only ever
  -- rate-limited guesses instead of actually locking the account.
  select hr->>'decision' into decision
  from public.hook_password_verification_attempt(
    jsonb_build_object('user_id', uid, 'valid', true)
  ) hr;
  insert into r values ('correct password mid-lockout still rejected', 'reject', decision);

  -- Simulate the 10 minute cooldown elapsing.
  update public.login_lockouts
    set locked_until = now() - interval '1 second',
        first_failed_at = now() - interval '11 minutes'
    where user_id = uid;

  -- Post-cooldown, wrong password again: must continue (a fresh count of 1),
  -- not stay locked and not silently carry the old count of 6 forward.
  select hr->>'decision' into decision
  from public.hook_password_verification_attempt(
    jsonb_build_object('user_id', uid, 'valid', false)
  ) hr;
  insert into r values ('after cooldown elapses, wrong password continues (fresh window)', 'continue', decision);
  select failed_count::text into msg from public.login_lockouts where user_id = uid;
  insert into r values ('failed_count reset to 1 after cooldown, not 7', '1', msg);

  -- Correct password clears tracked failures entirely.
  perform public.hook_password_verification_attempt(jsonb_build_object('user_id', uid, 'valid', true));
  insert into r values (
    'correct password clears the row',
    '0',
    (select count(*)::text from public.login_lockouts where user_id = uid)
  );

  -- Cleanup (rollback also handles this, but leave no doubt for anyone
  -- reading this test in isolation).
  delete from public.login_lockouts where user_id = uid;

  -- PostgREST exposure check: authenticated must NOT be able to call the
  -- hook directly (the exact 0054 pitfall — a SECURITY DEFINER function
  -- reachable as a public RPC endpoint).
  perform set_config('request.jwt.claims', json_build_object('sub', uid::text, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
  -- Note: while impersonating `authenticated`, this session also loses
  -- privilege on the temp table `r` (owned by postgres, no grants to
  -- authenticated) — so the outcome is captured in a variable here and only
  -- written to `r` after switching back to postgres below, rather than
  -- inserted directly inside this block.
  begin
    perform public.hook_password_verification_attempt(jsonb_build_object('user_id', uid, 'valid', true));
    outcome := 'CALLABLE';
  exception when insufficient_privilege then
    outcome := 'BLOCKED';
  end;
  perform set_config('role', 'postgres', true);
  insert into r values ('authenticated cannot call the hook directly', 'BLOCKED', outcome);
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
    raise exception '% scenario(s) FAILED — password lockout behaviour has regressed', failures;
  end if;
  raise notice 'all scenarios passed';
end;
$$;

rollback;
