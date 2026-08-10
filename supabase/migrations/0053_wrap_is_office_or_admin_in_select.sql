-- ============================================================================
-- Make the role check evaluate once per query instead of once per row.
--
-- STATUS: DRAFT — NOT APPLIED. (tests/unit/migration-header-truth.test.ts fails
-- the build if this line is still here once it IS applied.)
--
-- APPLY THIS ONE LAST, AND ON ITS OWN. It is the only migration in this batch
-- that rewrites existing RLS policies, which is the operation this project has
-- been burned by twice: 0034 dropped a policy by a guessed name and left a table
-- open for weeks, and 0045's column grants took web clock-in down. Nothing here
-- is urgent — see SEVERITY — so there is no reason to apply it in the same
-- window as anything else.
--
-- ---------------------------------------------------------------------------
-- SEVERITY: PERFORMANCE, NOT CORRECTNESS
-- ---------------------------------------------------------------------------
-- Item 2.22 is described as "24 unwrapped is_office_or_admin call sites". Two
-- corrections from counting them: it is 52 unwrapped occurrences (66 total, 14
-- already wrapped), and nothing about it is a security defect.
--
-- is_office_or_admin is STABLE (0027:29-32). Written bare in a policy, Postgres
-- re-evaluates it for every row scanned; wrapped in a scalar subquery it becomes
-- an InitPlan evaluated once. The boolean is identical either way — no row
-- changes hands, no one gains or loses access. This is Supabase's `rls_initplan`
-- advisory and nothing more.
--
-- The tables where it costs anything are the wide ones: job_items,
-- invoice_items, quote_items, time_entries.
--
-- ---------------------------------------------------------------------------
-- WHY THE TOKEN TABLES ARE EXCLUDED
-- ---------------------------------------------------------------------------
-- xero_tokens and google_tokens are deliberately left alone.
--
-- 0042 asserts their policy expression is EXACTLY 'is_office_or_admin(auth.uid())'
-- after whitespace stripping (0042:65, :149), and it does that on purpose: it
-- explains at :60-64 that a substring test would wave through
-- `USING (is_office_or_admin(auth.uid()) OR true)`, which grants everyone.
-- Rewriting those two would make 0042 unrunnable on its own.
--
-- Replaying the whole tree in order is unaffected — 0042 runs before this — but
-- there is no reason to take the risk: both tables hold exactly ONE row, so
-- per-row re-evaluation costs nothing measurable. Excluding them keeps 0042's
-- guard intact and loses nothing.
--
-- ---------------------------------------------------------------------------
-- SHAPE
-- ---------------------------------------------------------------------------
-- Policies are rebuilt from pg_policy rather than re-typed, so the command,
-- the roles, and the permissive/restrictive flag come from what is actually
-- deployed instead of from what a migration file believes is deployed. Only the
-- expression text changes.
--
-- The rewrite is idempotent by construction: it first UNWRAPS every
-- `(select is_office_or_admin(auth.uid()))` back to the bare form, then wraps
-- every bare occurrence. Trying to match "bare but not already wrapped" needs a
-- lookbehind Postgres regexes do not have, and getting that wrong would double-
-- wrap into `(select (select …))` on a second run.
--
-- THE ALIAS MATTERS, and cost a CI round to find. Postgres does not store the
-- text you write; it stores a parse tree and re-renders it. A scalar subquery
-- comes back with a column alias attached:
--
--     written:  (select is_office_or_admin(auth.uid()))
--     rendered: ( SELECT is_office_or_admin(auth.uid()) AS is_office_or_admin)
--
-- Every pattern below therefore has to tolerate an optional ` AS <name>` before
-- the closing paren. Without it the unwrap step matches nothing, so a re-run
-- double-wraps, and the assertion reports 28 freshly-rewritten policies as
-- "still unwrapped" — which is exactly what the first CI run said.
-- ============================================================================

-- Snapshot every policy BEFORE touching anything, so the assertions afterwards
-- can compare against what was actually deployed rather than against what this
-- file assumes. Without it there is no way to tell a policy that was always
-- TO PUBLIC (most of the baseline ones are, by design) from one whose roles the
-- rebuild dropped.
-- NOT `on commit drop`: CI applies migrations with plain psql
-- (.github/workflows/ci.yml:171-174), which is autocommit, so each statement is
-- its own transaction and the snapshot would vanish before the assertions below
-- could read it. Dropped explicitly at the end instead.
drop table if exists _policy_before;
create temp table _policy_before as
select p.polrelid::regclass::text as tbl,
       p.polname,
       p.polcmd,
       p.polpermissive,
       coalesce((select string_agg(r.rolname, ',' order by r.rolname)
                   from pg_roles r where r.oid = any(p.polroles)), 'PUBLIC') as roles
from pg_policy p;

do $$
declare
  pol record;
  new_qual text;
  new_check text;
  cmd text;
  roles text;
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
    where p.polrelid::regclass::text not in ('xero_tokens', 'google_tokens')
      and position('is_office_or_admin' in
            coalesce(pg_get_expr(p.polqual, p.polrelid), '')
         || coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '')) > 0
  loop
    -- Unwrap, then wrap. Idempotent, and safe to re-run.
    new_qual := regexp_replace(
                  regexp_replace(coalesce(pol.qual, ''),
                    '\(\s*SELECT\s+is_office_or_admin\(auth\.uid\(\)\)(\s+AS\s+[a-z_]+)?\s*\)', 'is_office_or_admin(auth.uid())', 'gi'),
                  'is_office_or_admin\(auth\.uid\(\)\)', '(select is_office_or_admin(auth.uid()))', 'gi');
    new_check := regexp_replace(
                  regexp_replace(coalesce(pol.chk, ''),
                    '\(\s*SELECT\s+is_office_or_admin\(auth\.uid\(\)\)(\s+AS\s+[a-z_]+)?\s*\)', 'is_office_or_admin(auth.uid())', 'gi'),
                  'is_office_or_admin\(auth\.uid\(\)\)', '(select is_office_or_admin(auth.uid()))', 'gi');

    -- Nothing to do if it was already wrapped.
    if new_qual = coalesce(pol.qual, '') and new_check = coalesce(pol.chk, '') then
      continue;
    end if;

    cmd := case pol.polcmd
             when 'r' then 'select' when 'a' then 'insert'
             when 'w' then 'update' when 'd' then 'delete' else 'all' end;
    roles := coalesce(pol.roles, 'public');

    execute format('drop policy %I on %s', pol.polname, pol.tbl);
    execute format(
      'create policy %I on %s as %s for %s to %s %s %s',
      pol.polname,
      pol.tbl,
      case when pol.polpermissive then 'permissive' else 'restrictive' end,
      cmd,
      roles,
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
  -- (a) No policy outside the two token tables may still call it bare.
  --
  --     Tested by DELETING every wrapped occurrence and asking whether any call
  --     survives. The obvious alternative — a regex meaning "the call not
  --     preceded by select" — cannot be written here: Postgres has no
  --     lookbehind, and the `[^t]` trick I first used matches the SPACE inside
  --     `(select is_office_or_admin(...))`, so it fires on exactly the policies
  --     that are already correct. Removing the good form and looking at the
  --     remainder has no such ambiguity.
  select string_agg(format('%s.%s', polrelid::regclass, polname), ', ') into leftover
  from pg_policy
  where polrelid::regclass::text not in ('xero_tokens', 'google_tokens')
    and regexp_replace(
          coalesce(pg_get_expr(polqual, polrelid), '') || coalesce(pg_get_expr(polwithcheck, polrelid), ''),
          '\(\s*SELECT\s+is_office_or_admin\(auth\.uid\(\)\)(\s+AS\s+[a-z_]+)?\s*\)', '', 'gi'
        ) ilike '%is_office_or_admin%';
  if leftover is not null then
    raise exception 'ASSERTION FAILED: still unwrapped in: %', leftover;
  end if;

  -- (b) Nothing double-wrapped. A second run must be a no-op, not a nesting.
  select count(*) into n
  from pg_policy
  where (coalesce(pg_get_expr(polqual, polrelid), '') || coalesce(pg_get_expr(polwithcheck, polrelid), ''))
        ilike '%(select (select is_office_or_admin%';
  if n > 0 then
    raise exception 'ASSERTION FAILED: % policy(ies) were double-wrapped', n;
  end if;

  -- (c) 0042's guarantee is untouched. If this migration reached the token
  --     tables, 0042 can no longer run and its protection is gone.
  select count(*) into n
  from pg_policy
  where polrelid::regclass::text in ('xero_tokens', 'google_tokens')
    and regexp_replace(coalesce(pg_get_expr(polqual, polrelid), ''), '\s+', '', 'g')
        = 'is_office_or_admin(auth.uid())';
  if n < 2 then
    raise exception
      'ASSERTION FAILED: the token-table policies no longer match 0042''s exact-text guard (found %)', n;
  end if;

  -- (d) EVERY policy still has the roles, command and permissive flag it had
  --     before, and none was lost. Compared against the snapshot rather than
  --     against an assumption.
  --
  --     Asserting "no policy is TO PUBLIC" would have been wrong on its face:
  --     most baseline policies are declared without a `to` clause and are
  --     PUBLIC by design, held shut by the auth.role() test inside them. That
  --     assertion would have failed on the first run, on a condition this
  --     migration neither created nor should fix. The question is not whether a
  --     policy is public — it is whether this migration CHANGED anything except
  --     the expression text.
  select string_agg(format('%s.%s', b.tbl, b.polname), ', ') into leftover
  from _policy_before b
  left join (
    select p.polrelid::regclass::text as tbl, p.polname, p.polcmd, p.polpermissive,
           coalesce((select string_agg(r.rolname, ',' order by r.rolname)
                       from pg_roles r where r.oid = any(p.polroles)), 'PUBLIC') as roles
    from pg_policy p
  ) a on a.tbl = b.tbl and a.polname = b.polname
  where a.polname is null                       -- policy disappeared
     or a.roles is distinct from b.roles        -- roles changed
     or a.polcmd is distinct from b.polcmd      -- command changed
     or a.polpermissive is distinct from b.polpermissive;

  if leftover is not null then
    raise exception
      'ASSERTION FAILED: rebuild changed more than the expression on: %', leftover;
  end if;
end;
$$;

-- ============================================================================
-- VERIFY AFTER APPLYING — the assertions above prove the TEXT changed
-- correctly. They do not prove the boundary still holds. Run the two suites
-- that do, and treat them as the gate:
--
--   psql "$SUPABASE_DB_URL" -f supabase/tests/money_boundary_sweep.sql
--   psql "$SUPABASE_DB_URL" -f supabase/tests/0035_rls_role_impersonation_test.sql
--
-- The first sweeps every money-shaped column against an impersonated technician
-- and raises MONEY BOUNDARY BREACHED if one is readable. If this migration got a
-- policy wrong, that is where it shows up — not in a slow query.
--
-- Rollback: re-run 0027, 0028, 0030, 0035, 0038 and 0042 in order. They recreate
-- the same policies in the bare form, which is functionally identical.
-- ============================================================================

drop table if exists _policy_before;
