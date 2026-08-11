-- ============================================================================
-- Take four internal functions off the public API.
--
-- STATUS: DRAFT — NOT APPLIED. (tests/unit/migration-header-truth.test.ts fails
-- the build if this line is still here once it IS applied.)
--
-- Found by Supabase's own security advisors against PRODUCTION, not by reading
-- the repo — every SECURITY DEFINER function in `public` is exposed as a
-- PostgREST RPC endpoint and carries `anon=X` in its ACL. Verified:
--
--   select proname, prosecdef, proacl from pg_proc ...
--   -> all six: "=X/postgres | anon=X | authenticated=X | service_role=X"
--
-- So https://<project>.supabase.co/rest/v1/rpc/reapply_time_entries_grants is
-- callable by anyone on the internet, with no session, and it runs GRANT and
-- REVOKE as its owner.
--
-- ---------------------------------------------------------------------------
-- SEVERITY, honestly: LOW, and it is worth saying why rather than overselling
-- it.
-- ---------------------------------------------------------------------------
-- The three trigger functions raise on a direct call — there is no NEW record
-- outside a trigger — so they are inert, not exploitable.
--
-- reapply_time_entries_grants() is the real one, and even it is close to
-- harmless: it re-asserts the grants 0046 intends, so calling it RESTORES the
-- intended state rather than weakening it. What it is not is something an
-- anonymous caller should be able to do. A SECURITY DEFINER function that
-- performs DDL should not sit on a public endpoint whatever its body does
-- today, because the body is what changes.
--
-- ---------------------------------------------------------------------------
-- WHAT THIS DELIBERATELY DOES NOT TOUCH, and this is the important half
-- ---------------------------------------------------------------------------
-- is_admin() and is_office_or_admin() carry the same advisory warning and are
-- LEFT ALONE. Measured against production:
--
--   is_office_or_admin   29 policies
--   is_admin              8 policies
--
-- RLS policy expressions are evaluated as the QUERYING user, so that user needs
-- EXECUTE on any function the policy calls. Revoking EXECUTE from
-- `authenticated` on either of these would make all 37 policy evaluations fail
-- — not deny rows, ERROR — and lock every signed-in user out of the app.
--
-- That is not hypothetical here. Migration 0045 took web clock-in down by
-- changing column grants, and 0034 left a table open for weeks by dropping a
-- policy under a guessed name. "The linter flagged it, so revoke it" is exactly
-- how both happened. The advisory is correct that these are callable; the
-- correct response is to accept it, because the alternative is an outage.
--
-- What an anon caller actually gains from them is the ability to ask whether a
-- given uuid is an admin. That is information disclosure of the mildest kind
-- and it needs a uuid to ask about.
--
-- The four revoked below are in no policy at all (verified by the same query),
-- so nothing evaluates them on behalf of a user.
-- ============================================================================

-- Triggers do not check EXECUTE on their function — the trigger fires as part
-- of the table's own machinery — so revoking here removes the RPC endpoint
-- without affecting inserts or updates in any way.
revoke execute on function public.handle_new_user() from anon, authenticated;
revoke execute on function public.apply_variation_pricing() from anon, authenticated;
revoke execute on function public.prevent_unauthorised_role_change() from anon, authenticated;

-- An operations helper, called by CI and by hand. service_role keeps it.
revoke execute on function public.reapply_time_entries_grants() from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Assert the outcome, including the part that must NOT have changed.
-- ---------------------------------------------------------------------------
do $$
declare
  still_public text;
  lost text;
begin
  -- (a) The four are off the public API.
  select string_agg(p.proname, ', ') into still_public
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname in ('handle_new_user', 'apply_variation_pricing',
                      'prevent_unauthorised_role_change', 'reapply_time_entries_grants')
    and (has_function_privilege('anon', p.oid, 'EXECUTE')
      or has_function_privilege('authenticated', p.oid, 'EXECUTE'));

  if still_public is not null then
    raise exception 'ASSERTION FAILED: still callable by anon/authenticated: %', still_public;
  end if;

  -- (b) THE ONE THAT MATTERS. The two functions every RLS policy depends on
  --     must still be executable by `authenticated`, or the app is down. This
  --     is asserted rather than assumed because the revokes above are one
  --     careless edit away from including them.
  select string_agg(p.proname, ', ') into lost
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname in ('is_admin', 'is_office_or_admin')
    and not has_function_privilege('authenticated', p.oid, 'EXECUTE');

  if lost is not null then
    raise exception
      'ASSERTION FAILED: authenticated lost EXECUTE on %, which 37 RLS policies call. Every signed-in user is locked out.', lost;
  end if;
end;
$$;

-- ============================================================================
-- VERIFY AFTER APPLYING
--
--   psql "$SUPABASE_DB_URL" -f supabase/tests/money_boundary_sweep.sql
--   psql "$SUPABASE_DB_URL" -f supabase/tests/0035_rls_role_impersonation_test.sql
--
-- Then sign in as a technician and as an office user and load a job. The
-- assertion above proves the grant still exists; only a real session proves the
-- policies still evaluate.
--
-- Rollback:
--   grant execute on function public.handle_new_user() to anon, authenticated;
--   grant execute on function public.apply_variation_pricing() to anon, authenticated;
--   grant execute on function public.prevent_unauthorised_role_change() to anon, authenticated;
--   grant execute on function public.reapply_time_entries_grants() to anon, authenticated;
-- ============================================================================
