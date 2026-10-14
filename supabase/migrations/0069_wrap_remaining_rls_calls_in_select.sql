-- ============================================================================
-- Finish what 0053 started: every per-row auth call in a public-schema policy
-- evaluates once per query.
--
-- STATUS: ✅ APPLIED IN PRODUCTION (2026-10-15, via SQL editor, on its own, after 0053;
-- money_boundary_sweep.sql and 0035_rls_role_impersonation_test.sql run clean
-- afterwards, as reported by Justin).
--
-- It also covers 0053's job: is_office_or_admin(auth.uid()) is wrapped here
-- too, producing exactly the text 0053 produces. So 0053 → 0069 (the CI draft
-- order) and 0069 alone end in the same state, and running 0053 after 0069 is
-- a no-op whose assertions hold.
--
-- ---------------------------------------------------------------------------
-- SEVERITY: PERFORMANCE, NOT CORRECTNESS — same as 0053
-- ---------------------------------------------------------------------------
-- 0053 wraps is_office_or_admin(auth.uid()). It left three other calls bare,
-- which Supabase's `auth_rls_initplan` advisory flags and which Postgres
-- re-evaluates for every row scanned:
--
--   is_admin(auth.uid())   SECURITY DEFINER, a profiles lookup per row. The
--                          worst one: "Admin can manage profiles" (0010) is
--                          FOR ALL, so it runs on every profiles SELECT —
--                          including every profiles(full_name) embed — and
--                          "Admin can manage job items" (0024) does the same
--                          on job_items.
--   auth.uid()             ~130 bare occurrences (own-row checks).
--   auth.role()            the baseline "authenticated users can …" policies
--                          on jobs, customers, sites, photos, notes, backflow…
--                          — the tables behind every count on the dashboard.
--
-- Wrapped in a scalar subquery each becomes an InitPlan evaluated once. All
-- three are STABLE within a statement, so the boolean is identical — no row
-- changes hands. supabase/tests/money_boundary_sweep.sql is the gate that
-- proves it.
--
-- ---------------------------------------------------------------------------
-- SCOPE
-- ---------------------------------------------------------------------------
-- * public schema only. storage.objects policies (0047/0049/0066) are already
--   written wrapped and are left alone.
-- * xero_tokens and google_tokens are excluded, for 0053's reason: 0042 asserts
--   their expression text exactly, and each holds one row.
-- * is_office_or_admin(auth.uid()) is wrapped here too (see STATUS above), and
--   the auth.uid() inside it is left bare, so the result is exactly the text
--   0053 produces and recognises, whichever order they run in.
-- * Expression text only. Commands, roles and permissive/restrictive flags come
--   from pg_policy and are asserted unchanged. The duplicate permissive
--   policies (profiles, job_items, time_entries, backflow_*) are NOT merged —
--   that would change who can do what; once wrapped, the duplicate costs one
--   InitPlan per query, not one per row.
--
-- ---------------------------------------------------------------------------
-- SHAPE — same technique as 0053, read its header for the reasoning
-- ---------------------------------------------------------------------------
-- Rebuilt from pg_policy; idempotent by unwrap-then-wrap; patterns tolerate the
-- ` AS <alias>` Postgres adds when it re-renders a scalar subquery:
--
--     written:  (select auth.uid())
--     rendered: ( SELECT auth.uid() AS uid)
--
-- The two role helpers are swapped for placeholders before auth.uid() is
-- wrapped, so the auth.uid() INSIDE them stays bare — the form 0053 and this
-- file both recognise — rather than becoming is_admin((select auth.uid())).
-- ============================================================================

-- Not `on commit drop`: CI applies migrations with autocommit psql (see 0053).
drop table if exists _policy_before_0069;
create temp table _policy_before_0069 as
select p.polrelid::regclass::text as tbl,
       p.polname,
       p.polcmd,
       p.polpermissive,
       coalesce((select string_agg(r.rolname, ',' order by r.rolname)
                   from pg_roles r where r.oid = any(p.polroles)), 'PUBLIC') as roles
from pg_policy p;

create or replace function pg_temp.wrap_rls_calls(expr text) returns text
language plpgsql immutable as $fn$
declare
  s text := coalesce(expr, '');
begin
  -- 1. Role helpers, wrapped or bare -> placeholders.
  s := regexp_replace(s, '\(\s*SELECT\s+(public\.)?is_office_or_admin\(auth\.uid\(\)\)(\s+AS\s+\w+)?\s*\)', '@@OFFICE_OR_ADMIN@@', 'gi');
  s := regexp_replace(s, '\m(public\.)?is_office_or_admin\(auth\.uid\(\)\)', '@@OFFICE_OR_ADMIN@@', 'gi');
  s := regexp_replace(s, '\(\s*SELECT\s+(public\.)?is_admin\(auth\.uid\(\)\)(\s+AS\s+\w+)?\s*\)', '@@ADMIN@@', 'gi');
  s := regexp_replace(s, '\m(public\.)?is_admin\(auth\.uid\(\)\)', '@@ADMIN@@', 'gi');
  -- 2. Unwrap auth.uid() / auth.role(), then wrap every occurrence.
  s := regexp_replace(s, '\(\s*SELECT\s+auth\.uid\(\)(\s+AS\s+\w+)?\s*\)', 'auth.uid()', 'gi');
  s := regexp_replace(s, '\(\s*SELECT\s+auth\.role\(\)(\s+AS\s+\w+)?\s*\)', 'auth.role()', 'gi');
  s := regexp_replace(s, 'auth\.uid\(\)', '(select auth.uid())', 'gi');
  s := regexp_replace(s, 'auth\.role\(\)', '(select auth.role())', 'gi');
  -- 3. Placeholders -> wrapped helpers.
  s := replace(s, '@@OFFICE_OR_ADMIN@@', '(select is_office_or_admin(auth.uid()))');
  s := replace(s, '@@ADMIN@@', '(select is_admin(auth.uid()))');
  return s;
end;
$fn$;

-- True when expr still contains a call this migration wraps, in bare form.
-- Deletes every WRAPPED form, then looks for any call left (Postgres regexes
-- have no lookbehind — see 0053 (a)). Used to pick what to rebuild AND by the
-- assertion below, so the two cannot disagree.
create or replace function pg_temp.has_bare_rls_call(expr text) returns boolean
language sql immutable as $fn$
  select regexp_replace(regexp_replace(regexp_replace(regexp_replace(
           coalesce(expr, ''),
           '\(\s*SELECT\s+(public\.)?is_office_or_admin\(auth\.uid\(\)\)(\s+AS\s+\w+)?\s*\)', '', 'gi'),
           '\(\s*SELECT\s+(public\.)?is_admin\(auth\.uid\(\)\)(\s+AS\s+\w+)?\s*\)', '', 'gi'),
           '\(\s*SELECT\s+auth\.uid\(\)(\s+AS\s+\w+)?\s*\)', '', 'gi'),
           '\(\s*SELECT\s+auth\.role\(\)(\s+AS\s+\w+)?\s*\)', '', 'gi')
         ~* '(auth\.uid\(\)|auth\.role\(\)|\mis_admin\(auth\.uid\(\)\)|is_office_or_admin\(auth\.uid\(\)\))'
$fn$;

do $$
declare
  pol record;
  new_qual text;
  new_check text;
  rebuilt int := 0;
begin
  for pol in
    select p.polname,
           p.polrelid::regclass::text as tbl,
           p.polcmd,
           p.polpermissive,
           pg_get_expr(p.polqual, p.polrelid)      as qual,
           pg_get_expr(p.polwithcheck, p.polrelid) as chk,
           (select string_agg(quote_ident(r.rolname), ', ')
              from pg_roles r where r.oid = any(p.polroles)) as roles
    from pg_policy p
    join pg_class c on c.oid = p.polrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname not in ('xero_tokens', 'google_tokens')
  loop
    -- Already fully wrapped: leave it. (Comparing rewritten text to the
    -- current text would not work — Postgres re-renders what we write, adding
    -- ` AS uid` and spacing — so every correct policy would be rebuilt.)
    if not pg_temp.has_bare_rls_call(pol.qual) and not pg_temp.has_bare_rls_call(pol.chk) then
      continue;
    end if;

    new_qual  := pg_temp.wrap_rls_calls(pol.qual);
    new_check := pg_temp.wrap_rls_calls(pol.chk);

    execute format('drop policy %I on %s', pol.polname, pol.tbl);
    execute format(
      'create policy %I on %s as %s for %s to %s %s %s',
      pol.polname,
      pol.tbl,
      case when pol.polpermissive then 'permissive' else 'restrictive' end,
      case pol.polcmd when 'r' then 'select' when 'a' then 'insert'
                      when 'w' then 'update' when 'd' then 'delete' else 'all' end,
      coalesce(pol.roles, 'public'),
      case when nullif(new_qual, '') is not null then 'using (' || new_qual || ')' else '' end,
      case when nullif(new_check, '') is not null then 'with check (' || new_check || ')' else '' end
    );
    rebuilt := rebuilt + 1;
  end loop;

  raise notice 'rebuilt % policies', rebuilt;
end;
$$;

-- ---------------------------------------------------------------------------
-- Assert the rewrite did what it claims AND that nothing was lost or widened.
-- ---------------------------------------------------------------------------
do $$
declare
  leftover text;
  n int;
begin
  -- (a) No bare call survives.
  select string_agg(format('%s.%s', c.relname, p.polname), ', ') into leftover
  from pg_policy p
  join pg_class c on c.oid = p.polrelid
  join pg_namespace ns on ns.oid = c.relnamespace
  where ns.nspname = 'public'
    and c.relname not in ('xero_tokens', 'google_tokens')
    and (pg_temp.has_bare_rls_call(pg_get_expr(p.polqual, p.polrelid))
         or pg_temp.has_bare_rls_call(pg_get_expr(p.polwithcheck, p.polrelid)));
  if leftover is not null then
    raise exception 'ASSERTION FAILED: still unwrapped in: %', leftover;
  end if;

  -- (b) Nothing double-wrapped, and no helper had its argument wrapped.
  select count(*) into n
  from pg_policy p
  where (coalesce(pg_get_expr(p.polqual, p.polrelid), '') || ' ' || coalesce(pg_get_expr(p.polwithcheck, p.polrelid), ''))
        ~* '(SELECT\s+\(\s*SELECT|is_admin\(\s*\(|is_office_or_admin\(\s*\()';
  if n > 0 then
    raise exception 'ASSERTION FAILED: % policy(ies) double-wrapped or with a wrapped helper argument', n;
  end if;

  -- (c) 0042's exact-text guard on the token tables still holds.
  select count(*) into n
  from pg_policy
  where polrelid::regclass::text in ('xero_tokens', 'google_tokens')
    and regexp_replace(coalesce(pg_get_expr(polqual, polrelid), ''), '\s+', '', 'g')
        = 'is_office_or_admin(auth.uid())';
  if n < 2 then
    raise exception
      'ASSERTION FAILED: the token-table policies no longer match 0042''s exact-text guard (found %)', n;
  end if;

  -- (d) Every policy still exists with the roles, command and permissive flag
  --     it had before, and none was added.
  select string_agg(format('%s.%s', b.tbl, b.polname), ', ') into leftover
  from _policy_before_0069 b
  left join (
    select p.polrelid::regclass::text as tbl, p.polname, p.polcmd, p.polpermissive,
           coalesce((select string_agg(r.rolname, ',' order by r.rolname)
                       from pg_roles r where r.oid = any(p.polroles)), 'PUBLIC') as roles
    from pg_policy p
  ) a on a.tbl = b.tbl and a.polname = b.polname
  where a.polname is null
     or a.roles is distinct from b.roles
     or a.polcmd is distinct from b.polcmd
     or a.polpermissive is distinct from b.polpermissive;
  if leftover is not null then
    raise exception
      'ASSERTION FAILED: rebuild changed more than the expression on: %', leftover;
  end if;

  if (select count(*) from pg_policy) <> (select count(*) from _policy_before_0069) then
    raise exception 'ASSERTION FAILED: policy count changed';
  end if;
end;
$$;

-- ============================================================================
-- VERIFY AFTER APPLYING — the assertions prove the TEXT; these prove the
-- boundary. Run both and treat them as the gate (SQL editor: paste each file):
--
--   supabase/tests/money_boundary_sweep.sql
--   supabase/tests/0035_rls_role_impersonation_test.sql
--
-- Rollback: not needed for correctness (the wrapped and bare forms are
-- equivalent). To restore the bare text anyway, re-run the policy-creating
-- migrations in order.
-- ============================================================================

drop table if exists _policy_before_0069;
