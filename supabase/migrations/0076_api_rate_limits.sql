-- ============================================================================
-- Per-user rate limit for the paid AI routes, shared across serverless instances.
--
-- STATUS: DRAFT — NOT APPLIED. Handed over for Justin to apply. Until it is,
-- the routes that call consume_rate_limit() fail OPEN (allow the request and
-- log "rate limiter unavailable") — see lib/api/rate-limit.ts.
--
-- WHY. /api/backflow/scan-data-plate (Claude vision) and /api/ai/polish-note
-- (Claude text) each spend real money per call and are open to every signed-in
-- user. A stolen session, or a buggy retry loop on a phone, could run them all
-- night. The only existing limiter in the app (app/api/geocode/route.ts) is an
-- in-memory Map, which on Vercel is per instance: every cold start gets a fresh
-- allowance, and concurrent instances each count separately
-- (HANDOVER-HARDENING.md item 3.10). The count has to live somewhere every
-- instance shares, and the database is the one thing they already share.
--
-- SHAPE. Same pattern as 0056's login lockout: one small table, one
-- SECURITY DEFINER function, EXECUTE for service_role only. The route has
-- already authenticated the caller and passes their id; a function callable by
-- `authenticated` would let any user burn (or reset, by guessing a bucket name)
-- someone else's allowance.
--
-- Fixed window, one row per (user, bucket), updated in a single
-- INSERT … ON CONFLICT so two concurrent requests cannot both read "under the
-- limit" — the row lock serialises them.
-- ============================================================================

create table public.api_rate_limits (
  user_id uuid not null references auth.users on delete cascade,
  bucket text not null,
  window_start timestamptz not null default now(),
  request_count int not null default 0,
  primary key (user_id, bucket)
);

comment on table public.api_rate_limits is
  'Fixed-window request counts per user per route bucket, for consume_rate_limit(). '
  'Written only by that function under service_role; not reachable through PostgREST.';

-- Belt and braces, same as login_lockouts (0055): RLS with no policies denies
-- every row to anon/authenticated on top of the grant revoke below.
alter table public.api_rate_limits enable row level security;
revoke all on table public.api_rate_limits from public, anon, authenticated;

create function public.consume_rate_limit(
  p_user_id uuid,
  p_bucket text,
  p_max int,
  p_window_seconds int
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_window constant interval := make_interval(secs => p_window_seconds);
  v_count int;
begin
  insert into public.api_rate_limits (user_id, bucket, window_start, request_count)
    values (p_user_id, p_bucket, now(), 1)
  on conflict (user_id, bucket) do update
    set request_count = case
          when public.api_rate_limits.window_start <= now() - v_window then 1
          else public.api_rate_limits.request_count + 1
        end,
        window_start = case
          when public.api_rate_limits.window_start <= now() - v_window then now()
          else public.api_rate_limits.window_start
        end
  returning request_count into v_count;

  -- true = allowed. A refused request still counts, so hammering a closed
  -- window does not reopen it any sooner — it just stays closed until the
  -- window rolls over.
  return v_count <= p_max;
end;
$$;

comment on function public.consume_rate_limit(uuid, text, int, int) is
  'Counts one request for (user, bucket) and returns whether it is within p_max per p_window_seconds. '
  'service_role only — called by lib/api/rate-limit.ts after the route has authenticated the caller.';

-- The 0054 lesson: `create function` grants EXECUTE to PUBLIC, and anon/
-- authenticated hold it only through PUBLIC, so revoke PUBLIC itself.
revoke execute on function public.consume_rate_limit(uuid, text, int, int) from public, anon, authenticated;
grant execute on function public.consume_rate_limit(uuid, text, int, int) to service_role;

-- ---------------------------------------------------------------------------
-- Assert the outcome.
-- ---------------------------------------------------------------------------
do $$
declare
  bad_grantees text;
begin
  if not has_function_privilege('service_role', 'public.consume_rate_limit(uuid, text, int, int)', 'EXECUTE') then
    raise exception 'ASSERTION FAILED: service_role cannot execute consume_rate_limit';
  end if;

  select string_agg(role, ', ') into bad_grantees
  from unnest(array['anon', 'authenticated']) as role
  where has_function_privilege(role, 'public.consume_rate_limit(uuid, text, int, int)', 'EXECUTE');
  if bad_grantees is not null then
    raise exception 'ASSERTION FAILED: % can still execute consume_rate_limit (PUBLIC grant not fully revoked)', bad_grantees;
  end if;

  select string_agg(role, ', ') into bad_grantees
  from unnest(array['anon', 'authenticated']) as role
  where has_table_privilege(role, 'public.api_rate_limits', 'SELECT')
     or has_table_privilege(role, 'public.api_rate_limits', 'INSERT')
     or has_table_privilege(role, 'public.api_rate_limits', 'UPDATE');
  if bad_grantees is not null then
    raise exception 'ASSERTION FAILED: % can still read or write api_rate_limits', bad_grantees;
  end if;

  if not exists (
    select 1 from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'api_rate_limits' and c.relrowsecurity
  ) then
    raise exception 'ASSERTION FAILED: RLS is not enabled on api_rate_limits';
  end if;
end;
$$;

-- ============================================================================
-- APPLY
--   supabase db push   (or paste into the SQL editor), then change the STATUS
--   line above to APPLIED — tests/unit/migration-header-truth.test.ts and
--   `npm run check:migrations` hold the header to account.
--
-- VERIFY AFTER APPLYING
--   psql "$SUPABASE_DB_URL" -f supabase/tests/0076_api_rate_limits_test.sql
--   The server log line "rate limiter unavailable" should stop appearing.
--
-- ROLLBACK (the routes fail open again, so nothing breaks):
--   drop function public.consume_rate_limit(uuid, text, int, int);
--   drop table public.api_rate_limits;
-- ============================================================================
