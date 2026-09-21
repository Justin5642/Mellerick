-- ============================================================================
-- Loosen the password sign-in lockout.
--
-- STATUS: ✅ APPLIED to production (recorded in
-- supabase_migrations.schema_migrations, version 0055) and gate-tested via
-- supabase/tests/0055_login_lockout_test.sql (8/8 scenarios passed against
-- the live database). The Postgres function/table/grants exist in
-- production. What is still OUTSTANDING is the one manual, non-SQL step
-- described further down: enabling the "Password Verification Attempt" hook
-- in the Supabase Dashboard. Until that's clicked, GoTrue never calls this
-- function, so login behaviour is unchanged in production despite this
-- migration being applied.
--
-- BEFORE: a user who mistyped their password once or twice was locked out of
-- their account for a full hour. That is far too aggressive for a small
-- plumbing office where the same few people sign in from the same phone/
-- laptop every day — a fat-thumbed password on a work van's phone shouldn't
-- cost someone an hour of dispatch.
--
-- AFTER: ~6 consecutive failed attempts before anything happens, then a 10
-- minute cooldown (not an hour). A correct password at any point before the
-- 6th failure clears the count entirely — this is "6 wrong in a row", not
-- "6 wrong ever". The existing "Forgot password?" email-reset link (already
-- on both login screens, and on the admin Staff pages per the prior
-- "Let admins trigger a password reset email for a staff member" commit) is
-- untouched by any of this: resetPasswordForEmail() is a different Auth
-- flow that never calls signInWithPassword, so it always works, including
-- while someone is mid-lockout.
--
-- WHERE THIS LIVES, AND WHY THAT ANSWERS "is it shared, or two builds?"
-- Web (app/login/page.tsx, app/forgot-password/page.tsx) and mobile
-- (mobile/app/login.tsx) both call supabase.auth.signInWithPassword()
-- against the one shared Supabase project — there is no separate lockout
-- logic to duplicate per platform, and there never has been one in this
-- repo (grepped for "lockout"/"failed_attempt"/"attempts" across both
-- app trees before writing this — nothing exists; the old hour-long
-- behaviour was Supabase's own opaque default, not anything checked into
-- this repo). The correct single place to put "own" brute-force logic is
-- therefore the ONE thing both clients already funnel through: GoTrue
-- itself, via its "Password Verification Attempt" Auth Hook
-- (https://supabase.com/docs/guides/auth/auth-hooks/password-verification-hook).
-- GoTrue calls this Postgres function on every password check, for every
-- client, so there is no platform-specific wiring needed on either side —
-- it applies to web and mobile the moment it's turned on, by construction,
-- not by two separate implementations agreeing to behave the same way.
--
-- STATUS: migration only, NOT YET ENABLED. Creating this function does not
-- turn it on — GoTrue only calls a Password Verification Attempt hook once
-- one is selected in the Dashboard (Authentication -> Hooks -> "Password
-- Verification Attempt" -> Postgres function -> public ->
-- hook_password_verification_attempt). That step has no CLI/SQL equivalent
-- and cannot be done from this migration; it must be clicked by whoever has
-- dashboard access. See the bottom of this file for the exact steps.
-- ============================================================================

create table public.login_lockouts (
  user_id uuid primary key references auth.users on delete cascade,
  failed_count int not null default 0,
  first_failed_at timestamptz not null default now(),
  locked_until timestamptz
);

comment on table public.login_lockouts is
  'Consecutive failed password sign-in attempts per user, for the hook_password_verification_attempt Auth Hook. '
  'Nothing in the app queries this table directly — it is read and written only by supabase_auth_admin, '
  'inside the hook, during a sign-in attempt.';

-- Defense in depth: this table is never meant to be reachable through
-- PostgREST at all. RLS-with-no-policies denies every row to anon/
-- authenticated outright, on top of (not instead of) the grant revokes
-- below — the same "belt and braces" the table privileges below also apply.
alter table public.login_lockouts enable row level security;

-- supabase_auth_admin is the role GoTrue itself connects as; it needs
-- ordinary table access to do its own bookkeeping (RLS does not apply to it
-- in practice, but the grants below are what make that access legitimate
-- rather than incidental). Explicit, not inherited — a database built purely
-- from migrations (CI, a fresh `supabase db reset`) must end up with the
-- exact same grants as production, per the lesson 0054 wrote down about not
-- relying on grants no migration makes.
grant usage on schema public to supabase_auth_admin;
grant all on table public.login_lockouts to supabase_auth_admin;
revoke all on table public.login_lockouts from public, anon, authenticated;

create function public.hook_password_verification_attempt(event jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := (event->>'user_id')::uuid;
  v_valid boolean := (event->>'valid')::boolean;
  v_row public.login_lockouts%rowtype;
  -- The product ask was "5-6 attempts, then a short cooldown (5-10 min)
  -- instead of an hour". 6 is the cutoff (the 6th failure in a row locks);
  -- 10 minutes is the cooldown — short enough that a genuine owner of the
  -- account loses a coffee break, not an hour of dispatch; long enough to
  -- blunt a script guessing passwords rather than a distracted human.
  v_max_attempts constant int := 6;
  v_cooldown constant interval := interval '10 minutes';
begin
  select * into v_row from public.login_lockouts where user_id = v_user_id;

  -- Still serving a lockout from a previous burst: reject regardless of
  -- whether THIS attempt's password happens to be correct. Skipping this
  -- check for a valid password would turn the lockout into a rate limit on
  -- guessing rather than an actual cooldown — the attacker just needs to
  -- land the right guess once during the window.
  if v_row.locked_until is not null and v_row.locked_until > now() then
    return jsonb_build_object(
      'decision', 'reject',
      'message', format(
        'Too many failed attempts. Try again in %s minute(s), or use "Forgot password?" to reset it by email now.',
        greatest(1, ceil(extract(epoch from (v_row.locked_until - now())) / 60))
      )
    );
  end if;

  if v_valid then
    -- Correct password, and no active lockout: clear any tracked failures.
    -- A typo followed by the correct password must never itself count
    -- towards a lockout — this is "6 wrong IN A ROW", not "6 wrong ever".
    if v_row.user_id is not null then
      delete from public.login_lockouts where user_id = v_user_id;
    end if;
    return jsonb_build_object('decision', 'continue');
  end if;

  -- Wrong password. Continue the rolling count — unless the previous
  -- failure was long enough ago (older than the cooldown window) that this
  -- reads as a fresh, unrelated mistake rather than the same burst
  -- continuing, in which case start over at 1 rather than carrying stale
  -- failures forward indefinitely.
  insert into public.login_lockouts (user_id, failed_count, first_failed_at)
    values (v_user_id, 1, now())
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
      where user_id = v_user_id;
    return jsonb_build_object(
      'decision', 'reject',
      'message', format(
        'Too many failed attempts. Try again in %s minutes, or use "Forgot password?" to reset it by email now.',
        extract(epoch from v_cooldown) / 60
      )
    );
  end if;

  return jsonb_build_object('decision', 'continue');
end;
$$;

comment on function public.hook_password_verification_attempt(jsonb) is
  'Supabase Auth "Password Verification Attempt" hook. Must be selected in Dashboard -> '
  'Authentication -> Hooks for GoTrue to actually call it — creating the function alone does not enable it.';

-- Same lesson as 0054: `create function` grants EXECUTE to PUBLIC by
-- default, and anon/authenticated hold it only by PUBLIC membership, so
-- revoking from them individually would be a no-op that reads like a fix.
-- Revoke PUBLIC itself, then grant back only to the one role that is
-- actually meant to call this — GoTrue, as supabase_auth_admin.
revoke execute on function public.hook_password_verification_attempt(jsonb) from public, anon, authenticated;
grant execute on function public.hook_password_verification_attempt(jsonb) to supabase_auth_admin;

-- ---------------------------------------------------------------------------
-- Assert the outcome.
-- ---------------------------------------------------------------------------
do $$
declare
  bad_grantees text;
begin
  -- (a) supabase_auth_admin can call the hook.
  if not exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'hook_password_verification_attempt'
      and has_function_privilege('supabase_auth_admin', p.oid, 'EXECUTE')
  ) then
    raise exception 'ASSERTION FAILED: supabase_auth_admin cannot execute hook_password_verification_attempt';
  end if;

  -- (b) Nobody else can — this is a SECURITY DEFINER function and, per 0054,
  --     every one of those is a live PostgREST RPC endpoint unless EXECUTE is
  --     off PUBLIC specifically.
  select string_agg(role, ', ') into bad_grantees
  from unnest(array['anon', 'authenticated']) as role
  where has_function_privilege(role, 'public.hook_password_verification_attempt(jsonb)', 'EXECUTE');

  if bad_grantees is not null then
    raise exception 'ASSERTION FAILED: % can still execute hook_password_verification_attempt (PUBLIC grant not fully revoked)', bad_grantees;
  end if;

  -- (c) Table access mirrors the function: auth admin only.
  if not has_table_privilege('supabase_auth_admin', 'public.login_lockouts', 'SELECT, INSERT, UPDATE, DELETE') then
    raise exception 'ASSERTION FAILED: supabase_auth_admin lacks full access to login_lockouts';
  end if;

  select string_agg(role, ', ') into bad_grantees
  from unnest(array['anon', 'authenticated']) as role
  where has_table_privilege(role, 'public.login_lockouts', 'SELECT');

  if bad_grantees is not null then
    raise exception 'ASSERTION FAILED: % can still read login_lockouts', bad_grantees;
  end if;

  -- (d) RLS is on, belt-and-braces with the grant revokes above.
  if not exists (
    select 1 from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'login_lockouts' and c.relrowsecurity
  ) then
    raise exception 'ASSERTION FAILED: RLS is not enabled on login_lockouts';
  end if;
end;
$$;

-- ============================================================================
-- MANUAL STEP REQUIRED — this migration does not enable the hook by itself.
--
-- In the Supabase Dashboard for this project: Authentication -> Hooks ->
-- "Password Verification Attempt" -> enable -> choose "Postgres function" ->
-- schema "public" -> function "hook_password_verification_attempt". Save.
--
-- Until that's done, GoTrue keeps whatever its previous (undocumented, and
-- not configured anywhere in this repo) behaviour was — this migration alone
-- changes nothing observable at sign-in time.
--
-- VERIFY AFTER ENABLING
--   psql "$SUPABASE_DB_URL" -f supabase/tests/0055_login_lockout_test.sql
--   Then by hand: fail a real sign-in 6 times in a row on /login (web) or
--   the mobile login screen; the 6th should show the "Too many failed
--   attempts... 10 minute(s)" message; a 7th immediately after should show
--   the same rather than re-checking the password; "Forgot password?" should
--   still work throughout.
--
-- ROLLBACK (also disable the Dashboard hook first, or GoTrue will error on
-- every sign-in once the function it points at is gone):
--   drop function public.hook_password_verification_attempt(jsonb);
--   drop table public.login_lockouts;
-- ============================================================================
