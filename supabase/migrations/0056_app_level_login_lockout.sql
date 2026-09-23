-- ============================================================================
-- App-level fallback for the password-verification lockout policy from 0055.
--
-- WHY THIS EXISTS: 0055's hook_password_verification_attempt() only takes
-- effect once GoTrue is configured (Dashboard -> Authentication -> Hooks ->
-- "Password Verification Attempt") to call it on every sign-in. Turning that
-- on turned out to require the Team/Enterprise Supabase plan -- this project
-- is on Pro, and the Dashboard doesn't offer the option at all there. The
-- function from 0055 is applied and gate-tested but structurally unreachable
-- in production, and stays that way unless the plan changes.
--
-- This migration adds the same policy (6 consecutive failures, 10 minute
-- cooldown, reset-if-stale, clear-on-success) as three service_role-only
-- functions, reusing the login_lockouts table 0055 already created. They are
-- called from a new trusted server-side route (app/api/auth/login/route.ts)
-- that performs the actual signInWithPassword() call itself, so the app
-- always knows the REAL outcome of an attempt.
--
-- THIS IS WHY THE FUNCTIONS ARE service_role-ONLY, NOT anon/authenticated:
-- a naive design where the browser/mobile client itself reports "that
-- failed, please record a failure" would let anyone holding the public anon
-- key call record_login_failure() directly and repeatedly against any known
-- staff email, with no valid credentials at all, to lock a coworker out on
-- purpose. Routing check + real signInWithPassword + record through ONE
-- trusted server-side request, using service_role (never shipped to any
-- client), closes that off -- the same role the 0054 lesson exists to
-- protect against exposing by accident.
--
-- hook_password_verification_attempt() from 0055 is left untouched: it is
-- already applied and gate-tested in production, and duplicating its policy
-- here rather than refactoring it avoids risking that verified code path, in
-- case the Dashboard hook ever does become available later (Team plan, or
-- Supabase changes the gating).
-- ============================================================================

create function public.check_login_lockout(p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.login_lockouts%rowtype;
begin
  select * into v_row from public.login_lockouts where user_id = p_user_id;

  if v_row.locked_until is not null and v_row.locked_until > now() then
    return jsonb_build_object(
      'locked', true,
      'message', format(
        'Too many failed attempts. Try again in %s minute(s), or use "Forgot password?" to reset it by email now.',
        greatest(1, ceil(extract(epoch from (v_row.locked_until - now())) / 60))
      )
    );
  end if;

  return jsonb_build_object('locked', false);
end;
$$;

comment on function public.check_login_lockout(uuid) is
  'App-level fallback for 0055''s hook (unreachable on the Pro plan -- see migration 0056). '
  'Called by app/api/auth/login/route.ts before attempting signInWithPassword.';

create function public.record_login_failure(p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.login_lockouts%rowtype;
  v_max_attempts constant int := 6;
  v_cooldown constant interval := interval '10 minutes';
begin
  insert into public.login_lockouts (user_id, failed_count, first_failed_at)
    values (p_user_id, 1, now())
  on conflict (user_id) do update
    set failed_count = case
          when public.login_lockouts.first_failed_at < now() - v_cooldown then 1
          else public.login_lockouts.failed_count + 1
        end,
        first_failed_at = case
          when public.login_lockouts.first_failed_at < now() - v_cooldown then now()
          else public.login_lockouts.first_failed_at
        end,
        locked_until = case
          when public.login_lockouts.first_failed_at < now() - v_cooldown then null
          else public.login_lockouts.locked_until
        end
  returning * into v_row;

  if v_row.failed_count >= v_max_attempts then
    update public.login_lockouts
      set locked_until = now() + v_cooldown
      where user_id = p_user_id;
    return jsonb_build_object(
      'locked', true,
      'message', format(
        'Too many failed attempts. Try again in %s minutes, or use "Forgot password?" to reset it by email now.',
        extract(epoch from v_cooldown) / 60
      )
    );
  end if;

  return jsonb_build_object('locked', false);
end;
$$;

comment on function public.record_login_failure(uuid) is
  'App-level fallback for 0055''s hook -- see migration 0056. Called by app/api/auth/login/route.ts '
  'after a real signInWithPassword() call fails.';

create function public.clear_login_lockout(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from public.login_lockouts where user_id = p_user_id;
end;
$$;

comment on function public.clear_login_lockout(uuid) is
  'App-level fallback for 0055''s hook -- see migration 0056. Called by app/api/auth/login/route.ts '
  'after a real signInWithPassword() call succeeds.';

-- Same lesson as 0054/0055: `create function` grants EXECUTE to PUBLIC by
-- default, and anon/authenticated hold it only by PUBLIC membership, so
-- revoking from them individually would be a no-op that reads like a fix.
-- Revoke PUBLIC itself, then grant back only to service_role -- the role the
-- new API route authenticates as, and the only one meant to call these.
revoke execute on function public.check_login_lockout(uuid) from public, anon, authenticated;
revoke execute on function public.record_login_failure(uuid) from public, anon, authenticated;
revoke execute on function public.clear_login_lockout(uuid) from public, anon, authenticated;
grant execute on function public.check_login_lockout(uuid) to service_role;
grant execute on function public.record_login_failure(uuid) to service_role;
grant execute on function public.clear_login_lockout(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- Assert the outcome.
-- ---------------------------------------------------------------------------
do $$
declare
  bad_grantees text;
begin
  if not (
    has_function_privilege('service_role', 'public.check_login_lockout(uuid)', 'EXECUTE')
    and has_function_privilege('service_role', 'public.record_login_failure(uuid)', 'EXECUTE')
    and has_function_privilege('service_role', 'public.clear_login_lockout(uuid)', 'EXECUTE')
  ) then
    raise exception 'ASSERTION FAILED: service_role cannot execute one or more lockout functions';
  end if;

  -- Nobody else can -- this is a SECURITY DEFINER function and, per 0054, every
  -- one of those is a live PostgREST RPC endpoint unless EXECUTE is off PUBLIC
  -- specifically.
  select string_agg(check_name, ', ') into bad_grantees
  from (
    select role || '/' || fn as check_name
    from unnest(array['anon', 'authenticated']) as role
    cross join unnest(array[
      'public.check_login_lockout(uuid)',
      'public.record_login_failure(uuid)',
      'public.clear_login_lockout(uuid)'
    ]) as fn
    where has_function_privilege(role, fn, 'EXECUTE')
  ) x;

  if bad_grantees is not null then
    raise exception 'ASSERTION FAILED: % can still execute lockout functions (PUBLIC grant not fully revoked)', bad_grantees;
  end if;
end;
$$;

-- ============================================================================
-- VERIFY AFTER APPLYING
--   psql "$SUPABASE_DB_URL" -f supabase/tests/0056_app_login_lockout_test.sql
--   Then by hand: fail a real sign-in 6 times in a row on /login (web) or the
--   mobile login screen; the 6th should show "Too many failed attempts...";
--   "Forgot password?" should still work throughout.
--
-- ROLLBACK:
--   drop function public.check_login_lockout(uuid);
--   drop function public.record_login_failure(uuid);
--   drop function public.clear_login_lockout(uuid);
-- (login_lockouts table itself is owned by 0055 -- do not drop it here.)
-- ============================================================================
